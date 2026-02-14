"""
Moodle LMS Scraper Backend
===========================
FastAPI backend that authenticates against a Moodle instance via web scraping
and exposes scraped data (dashboard, attendance) as JSON endpoints.

Target: https://lmsug24.iiitkottayam.ac.in
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import requests
import re
import json
import time
import os
import logging
from datetime import datetime
from bs4 import BeautifulSoup
from typing import Optional, List

# ════════ LOGGING SETUP ════════
if not os.path.exists("logs"):
    os.makedirs("logs")
logging.basicConfig(
    filename='logs/backend.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ════════ CONFIGURATION ════════
MOODLE_BASE_URL = "https://lmsug24.iiitkottayam.ac.in"
LOGIN_URL = f"{MOODLE_BASE_URL}/login/index.php"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ════════ DATA MODELS ════════
class LoginRequest(BaseModel):
    username: str
    password: str

class CourseInfo(BaseModel):
    id: int
    name: str
    shortname: str
    url: str

class DashboardResponse(BaseModel):
    success: bool
    user_name: Optional[str] = None
    courses: list[CourseInfo] = []
    message: Optional[str] = None

class Session(BaseModel):
    date: str  # YYYY-MM-DD
    status: str
    points: str

class CourseAttendance(BaseModel):
    course_name: str
    course_id: int
    present: int = 0
    absent: int = 0
    late: int = 0
    excused: int = 0
    total_sessions: int = 0
    percentage: float = 0.0
    has_attendance: bool = True
    sessions: List[Session] = []

class AttendanceResponse(BaseModel):
    overall_percentage: float
    total_present: int
    total_sessions: int
    courses: list[CourseAttendance]

class Assignment(BaseModel):
    id: int
    name: str
    course: str
    due_date: str
    url: str

class AssignmentsResponse(BaseModel):
    assignments: list[Assignment]

# ════════ HELPERS ════════
def get_sesskey(soup):
    # Method 1: M.cfg.sesskey in scripts
    try:
        scripts = soup.find_all("script")
        for s in scripts:
            if s.string and "sesskey" in s.string:
                match = re.search(r'"sesskey":"([^"]+)"', s.string)
                if match: 
                    return match.group(1)
    except: pass
    
    # Method 2: Logout link
    try:
        logout_link = soup.find("a", href=True, string=re.compile(r"Log\s*out", re.I))
        if logout_link and "sesskey=" in logout_link["href"]:
            return logout_link["href"].split("sesskey=")[1].split("&")[0]
            
        # Method 3: Any link with sesskey
        for a in soup.find_all("a", href=True):
            if "sesskey=" in a["href"]:
                 return a["href"].split("sesskey=")[1].split("&")[0]
    except: pass
    
    logger.warning("Failed to extract sesskey from page")
    return None

def get_courses_via_ajax(session, sesskey):
    """
    Scrape courses via Moodle's timeline/courses service call.
    Usually: core_course_get_enrolled_courses_by_timeline_classification
    """
    url = f"{MOODLE_BASE_URL}/lib/ajax/service.php?sesskey={sesskey}&info=core_course_get_enrolled_courses_by_timeline_classification"
    payload = [{
        "index": 0,
        "methodname": "core_course_get_enrolled_courses_by_timeline_classification",
        "args": {
            "offset": 0,
            "limit": 0,
            "classification": "inprogress",
            "sort": "fullname"
        }
    }]
    
    courses = []
    try:
        r = session.post(url, json=payload, timeout=10)
        data = r.json()
        if data and not data[0].get("error"):
            raw_courses = data[0]['data']['courses']
            for rc in raw_courses:
                courses.append({
                    "id": rc['id'], 
                    "fullname": rc['fullname'], 
                    "shortname": rc.get('shortname', rc['fullname']),
                    "url": rc['viewurl']
                })
        else:
            logger.warning(f"AJAX courses failed or empty: {data}")
    except Exception as e:
        logger.error(f"AJAX scraping exception: {e}")
    
    # Fallback: site home or scraping links if AJAX fails
    return courses

# ════════ ROUTES ════════

# ════════ SESSION MANAGEMENT ════════
USER_SESSIONS = {}  # {username: {"session": s, "expiry": ts}}
SESSION_TIMEOUT = 300  # 5 minutes

def get_authenticated_session(username, password):
    now = time.time()
    existing = USER_SESSIONS.get(username)
    
    if existing and existing["expiry"] > now:
        # Check if session is still valid by requesting /my/
        s = existing["session"]
        # Optimistic reuse
        return s
        
    # Create new session
    s = requests.Session()
    try:
        r = s.get(LOGIN_URL)
        soup = BeautifulSoup(r.text, "html.parser")
        token = soup.find("input", {"name": "logintoken"})["value"]
        
        r = s.post(LOGIN_URL, data={"username": username, "password": password, "logintoken": token})
        if "login/index.php" in r.url:
            raise Exception("Invalid credentials")
            
        USER_SESSIONS[username] = {"session": s, "expiry": now + SESSION_TIMEOUT}
        return s
    except Exception as e:
        logger.error(f"Login error for {username}: {e}")
        raise HTTPException(status_code=401, detail="Login failed")

# ════════ ROUTES ════════

@app.get("/")
def read_root():
    if os.path.exists("index.html"): return FileResponse("index.html")
    return {"message": "Backend Running"}

@app.post("/scrape/dashboard", response_model=DashboardResponse)
def scrape_dashboard(creds: LoginRequest):
    try:
        session = get_authenticated_session(creds.username, creds.password)
        r = session.get(f"{MOODLE_BASE_URL}/my/")
    except HTTPException as e:
        raise e
    except Exception:
        raise HTTPException(status_code=500, detail="Dashboard fetch error")

    # Get sesskey
    soup = BeautifulSoup(r.text, "html.parser")
    sesskey = get_sesskey(soup)
    user_name = "Student"
    
    # Extract name
    u_text = soup.find("div", class_="usermenu") or soup.find("span", class_="usertext")
    if u_text: user_name = u_text.get_text(strip=True)

    # Scrape courses
    courses_data = []
    if sesskey:
        logger.info(f"Sesskey found: {sesskey}, trying AJAX scraping")
        raw_courses = get_courses_via_ajax(session, sesskey)
        for c in raw_courses:
            courses_data.append(CourseInfo(id=c['id'], name=c['fullname'], shortname=c['shortname'], url=c['url']))
    
    # Fallback to scraping links if AJAX returned 0
    if len(courses_data) == 0:
        logger.warning("AJAX returned 0 courses, falling back to link scraping")
        seen = set()
        for link in soup.find_all("a", href=True):
            if "/course/view.php?id=" in link["href"]:
                try:
                    cid = int(link["href"].split("id=")[1].split("&")[0])
                    if cid not in seen and cid != 1:
                        courses_data.append(CourseInfo(id=cid, name=link.get_text(strip=True), shortname="", url=link["href"]))
                        seen.add(cid)
                except: pass

    logger.info(f"Final course count: {len(courses_data)}")
    return DashboardResponse(success=True, user_name=user_name, courses=courses_data)

@app.post("/scrape/attendance", response_model=AttendanceResponse)
def scrape_attendance(creds: LoginRequest):
    try:
        session = get_authenticated_session(creds.username, creds.password)
    except:
        raise HTTPException(status_code=401, detail="Login failed")

    # Get sesskey and courses
    # We must replicate logic to get correct course list
    r = session.get(f"{MOODLE_BASE_URL}/my/") # ensures sesskey is fresh
    soup = BeautifulSoup(r.text, "html.parser")
    sesskey = get_sesskey(soup)
    
    courses = []
    if sesskey:
        courses = get_courses_via_ajax(session, sesskey)
    
    if not courses:
        # Fallback scraping
        seen = set()
        for link in soup.find_all("a", href=True):
            if "/course/view.php?id=" in link["href"]:
                try:
                    cid = int(link["href"].split("id=")[1].split("&")[0])
                    if cid not in seen and cid != 1:
                        courses.append({"id": cid, "fullname": link.get_text(strip=True)})
                        seen.add(cid)
                except: pass

    results = []
    total_present = 0
    total_sessions = 0

    for c in courses:
        cid = c["id"]
        cname = c["fullname"]
        logger.info(f"Processing course: {cname} ({cid})")
        
        # 1. Go to course
        r_course = session.get(f"{MOODLE_BASE_URL}/course/view.php?id={cid}")
        csoup = BeautifulSoup(r_course.text, "html.parser")
        
        # 2. Find Attendance Module
        att_link = None
        # Try finding mod/attendance/view.php link
        for l in csoup.find_all("a", href=True):
            if "mod/attendance/view.php?id=" in l["href"]:
                att_link = l["href"]
                break
        
        if not att_link:
            logger.info(f" - No attendance link found")
            results.append(CourseAttendance(course_name=cname, course_id=cid, has_attendance=False))
            continue

        # 3. Scrape Attendance Table
        final_url = f"{att_link}&view=all" if "?" in att_link else f"{att_link}?view=all"
        r_att = session.get(final_url)
        asoup = BeautifulSoup(r_att.text, "html.parser")
        
        tables = asoup.find_all("table", class_="generaltable") or asoup.find_all("table")
        if not tables:
            logger.warning(f" - Table missing on attendance page")
            results.append(CourseAttendance(course_name=cname, course_id=cid, has_attendance=False))
            continue
            
        # Locate correct table
        target = tables[0]
        for t in tables:
            headers = [th.get_text(strip=True).lower() for th in t.find_all("th")]
            if any("status" in h for h in headers):
                target = t
                break
        
        # Parse rows
        present = absent = late = excused = 0
        sessions_list = []
        rows = target.find_all("tr")
        
        for row in rows:
            cells = row.find_all("td")
            if not cells: continue
            
            # Text extraction
            row_text = row.get_text(" ", strip=True).lower()
            status_raw = "Unknown"
            
            # Helper to check keywords
            def check_status(txt):
                if "present" in txt: return "Present"
                if "absent" in txt: return "Absent"
                if "late" in txt: return "Late"
                if "excused" in txt: return "Excused"
                return None

            # Try column 2 or 3 specific check
            if len(cells) >= 3:
                sc = cells[2].get_text(strip=True).lower()
                status_raw = check_status(sc) or status_raw
                if status_raw == "Unknown" and len(cells) > 3:
                    sc = cells[3].get_text(strip=True).lower()
                    status_raw = check_status(sc) or status_raw
            
            # Fallback to row text
            if status_raw == "Unknown":
                status_raw = check_status(row_text) or "Unknown"

            if status_raw in ["Unknown", None]: continue
            
            # Parse Date logic
            date_str = ""
            try:
                date_txt = cells[0].get_text(strip=True)
                # Regex for "4 Feb 2026"
                m = re.search(r"(\d{1,2}\s+\w{3}\s+\d{4})", date_txt)
                if m:
                    dt = datetime.strptime(m.group(1), "%d %b %Y")
                    date_str = dt.strftime("%Y-%m-%d")
            except: pass
            
            sessions_list.append(Session(date=date_str, status=status_raw, points=""))
            
            s_low = status_raw.lower()
            if "present" in s_low: present += 1
            elif "absent" in s_low: absent += 1
            elif "late" in s_low: late += 1
            elif "excused" in s_low: excused += 1

        total_s = present + absent + late + excused
        pct = 0.0
        if total_s > 0:
            pct = round((present / total_s) * 100, 1)
            # Try parsing footer %
            for r in rows:
                if "percentage" in r.get_text(strip=True).lower():
                    m = re.search(r"(\d+(\.\d+)?)%", r.get_text())
                    if m: pct = float(m.group(1))

        results.append(CourseAttendance(
            course_name=cname, course_id=cid,
            present=present, absent=absent, late=late, excused=excused,
            total_sessions=total_s, percentage=pct, has_attendance=True,
            sessions=sessions_list
        ))
        total_present += present
        total_sessions += total_s

    overall = round((total_present / total_sessions * 100) if total_sessions else 0.0, 1)
    logger.info(f"Attendance scraping done. Overall: {overall}%")
    return AttendanceResponse(
        overall_percentage=overall, total_present=total_present, 
        total_sessions=total_sessions, courses=results
    )


# ════════ ASSIGNMENTS ════════
def get_assignments_via_ajax(session, sesskey):
    """
    Get timeline events (Upcoming activities).
    """
    url = f"{MOODLE_BASE_URL}/lib/ajax/service.php?sesskey={sesskey}&info=core_calendar_get_action_events_by_timesort"
    payload = [{
        "index": 0,
        "methodname": "core_calendar_get_action_events_by_timesort",
        "args": {
            "limitnum": 10,
            "timesortfrom": int(time.time() - 86400), # Include yesterday just in case
            "limittononsuspendedevents": True
        }
    }]
    
    assigns = []
    try:
        r = session.post(url, json=payload, timeout=10)
        data = r.json()
        if data and not data[0].get("error"):
            events = data[0]['data']['events']
            for evt in events:
                # Filter for assignments/quizzes
                mod = evt.get('modulename', '').lower()
                if mod in ['assign', 'quiz', 'forum'] or True: # Capture all action events
                    due_ts = evt.get('timesort', 0)
                    due_date = datetime.fromtimestamp(due_ts).strftime("%A, %d %B %Y, %I:%M %p")
                    
                    assigns.append(Assignment(
                        id=evt.get('id', 0),
                        name=evt.get('name', 'Untitled'),
                        course=evt.get('course', {}).get('fullname', 'Unknown Course'),
                        due_date=due_date,
                        url=evt.get('url', '')
                    ))
    except Exception as e:
        logger.error(f"Assignment scraping error: {e}")
        
    return assigns

@app.post("/scrape/assignments", response_model=AssignmentsResponse)
def scrape_assignments(creds: LoginRequest):
    try:
        session = get_authenticated_session(creds.username, creds.password)
    except:
        return AssignmentsResponse(assignments=[])
        
    # Get sesskey
    r = session.get(f"{MOODLE_BASE_URL}/my/")
    soup = BeautifulSoup(r.text, "html.parser")
    sesskey = get_sesskey(soup)
    
    assigns = []
    if sesskey:
        assigns = get_assignments_via_ajax(session, sesskey)
        logger.info(f"Scraped {len(assigns)} pending assignments via AJAX")
        
    return AssignmentsResponse(assignments=assigns)

# Mount static last to avoid overwriting API routes
try:
    if os.path.exists("static"):
        app.mount("/static", StaticFiles(directory="static"), name="static")
except: pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

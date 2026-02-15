import logging
import time
import re
from datetime import datetime

# Mocking some parts of main.py logic for verification
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("test_verify")

def safe_request_mock(method, url, session=None, retries=2, backoff=0.1):
    """
    Simulated safe_request for verification.
    """
    for i in range(retries + 1):
        try:
            logger.info(f"Attempting {method} {url} (Attempt {i+1})")
            if "fail" in url and i < retries:
                raise Exception("Transient Error")
            if "error" in url:
                raise Exception("Permanent Error")
            return "Success"
        except Exception as e:
            if i < retries:
                wait = backoff * (2 ** i)
                logger.warning(f"Request failed: {url}. Retrying in {wait}s...")
                time.sleep(wait)
            else:
                logger.error(f"Final request failure for {url}: {e}")
                return "Failed"

def check_status_mock(txt):
    txt = txt.strip().lower()
    if not txt: return None
    if "present" in txt: return "Present"
    if "absent" in txt: return "Absent"
    if "late" in txt: return "Late"
    if "excused" in txt: return "Excused"
    if txt == "p": return "Present"
    if txt == "a": return "Absent"
    if txt == "l": return "Late"
    if txt == "e": return "Excused"
    return None

def parse_date_mock(date_txt):
    try:
        # 1. "Wed 4 Feb 2026"
        m = re.search(r"(\d{1,2}\s+\w{3}\s+\d{4})", date_txt)
        if m:
            dt = datetime.strptime(m.group(1), "%d %b %Y")
            return dt.strftime("%Y-%m-%d")
        else:
            # 2. "04.02.26" or similar
            m2 = re.search(r"(\d{2})[./](\d{2})[./](\d{2,4})", date_txt)
            if m2:
                y = m2.group(3)
                if len(y) == 2: y = "20" + y
                return f"{y}-{m2.group(2)}-{m2.group(1)}"
    except: pass
    return None

# Test cases
print("--- Testing safe_request ---")
print(f"Test Success: {safe_request_mock('GET', 'https://example.com')}")
print(f"Test Retry Trigger: {safe_request_mock('GET', 'https://fail.com')}")
print(f"Test Permanent Failure: {safe_request_mock('GET', 'https://error.com')}")

print("\n--- Testing Date Parsing Fallbacks ---")
dates = ["Wed 4 Feb 2026", "05.02.26", "06/02/2026", "Unknown format"]
for d in dates:
    print(f"Original: {d} -> Parsed: {parse_date_mock(d)}")

print("\n--- Testing Status Codes ---")
statuses = ["Present", "absent", "P", "A", "L", "E", "Late", "Excused", "Unknown"]
for s in statuses:
    print(f"Original: {s} -> Standardized: {check_status_mock(s)}")

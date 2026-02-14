/**
 * LMS PRO — True Black Glass
 * Dashboard, Attendance Detail, Calendar, Assignments
 */

const API_BASE = window.location.hostname.includes("vercel.app") ? "" : "https://lms-2055kmcqy-sakki221s-projects.vercel.app";

/* ═══════ STATE ═══════ */
let credentials = null;
let appData = { dashboard: null, attendance: null, assignments: null };
let sessionMap = {};  // "YYYY-MM-DD" -> [{course, status, ...}]
let calMonth = new Date();

/* ═══════ HELPERS ═══════ */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toast(msg, type = "info") {
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.textContent = msg;
    $("#toast-container").appendChild(t);
    setTimeout(() => { t.classList.add("toast-exit"); setTimeout(() => t.remove(), 300); }, 3000);
}

function setStep(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("active", "done", "error");
    el.classList.add(state);
}

/* ═══════ NAV ═══════ */
$$(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        $$(".nav-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        $$(".view").forEach(v => v.classList.remove("active"));
        $(`#view-${btn.dataset.view}`).classList.add("active");

        // Reset course-detail if leaving attendance
        if (btn.dataset.view !== "attendance") {
            $("#att-course-list").style.display = "";
            $("#course-detail").style.display = "none";
        }
    });
});

/* ═══════ LOGIN ═══════ */
const loginScreen = $("#login-screen");
const appScreen = $("#app-screen");
const overlay = $("#loading-overlay");

$("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = $("#username").value.trim();
    const p = $("#password").value.trim();
    if (!u || !p) return;

    const btn = $("#login-btn");
    btn.classList.add("loading");
    $("#login-error").textContent = "";
    overlay.classList.add("active");
    setStep("step-login", "active");

    try {
        // 1. Dashboard
        const dr = await fetch(`${API_BASE}/scrape/dashboard`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: u, password: p })
        });
        const dd = await dr.json();
        if (!dr.ok) throw new Error(dd.detail || "Login failed");

        credentials = { username: u, password: p };
        appData.dashboard = dd;
        setStep("step-login", "done");
        setStep("step-courses", "done");

        // 2. Parallel: attendance + assignments
        setStep("step-att", "active");
        setStep("step-assign", "active");

        const [attR, assR] = await Promise.allSettled([
            fetch(`${API_BASE}/scrape/attendance`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(credentials)
            }).then(r => r.json()),
            fetch(`${API_BASE}/scrape/assignments`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(credentials)
            }).then(r => r.json()),
        ]);

        if (attR.status === "fulfilled" && attR.value?.courses) {
            appData.attendance = attR.value;
            buildSessionMap(attR.value.courses);
            setStep("step-att", "done");
        } else { setStep("step-att", "done"); }

        if (assR.status === "fulfilled" && assR.value?.assignments) {
            appData.assignments = assR.value;
            setStep("step-assign", "done");
        } else { setStep("step-assign", "done"); }

        await sleep(400);

        // Build UI
        renderDashboard();
        renderAttendanceList();
        renderCalendar();
        renderAssignments();

        overlay.classList.remove("active");
        loginScreen.classList.remove("active");
        appScreen.classList.add("active");
        $("#user-initials").textContent = u.charAt(0).toUpperCase();

    } catch (err) {
        overlay.classList.remove("active");
        $("#login-error").textContent = err.message || "Connection failed";
    } finally {
        btn.classList.remove("loading");
    }
});

/* ═══════ LOGOUT ═══════ */
$("#logout-btn").addEventListener("click", () => {
    credentials = null;
    appData = { dashboard: null, attendance: null, assignments: null };
    sessionMap = {};
    $("#login-form").reset();
    $("#courses-grid").innerHTML = "";
    $("#att-course-list").innerHTML = "";
    $("#assign-list").innerHTML = "";
    appScreen.classList.remove("active");
    loginScreen.classList.add("active");
});

/* ══════════════════════════════════════
   DASHBOARD
   ══════════════════════════════════════ */
function renderDashboard() {
    const courses = appData.dashboard?.courses || [];
    const att = appData.attendance;
    const assigns = appData.assignments?.assignments || [];

    $("#stat-courses").textContent = courses.length;
    const overall = att?.overall_percentage ?? 0;
    const statEl = $("#stat-att");
    statEl.textContent = `${overall}%`;
    statEl.style.color = overall >= 75 ? "var(--green)" : overall >= 65 ? "var(--amber)" : "var(--red)";
    $("#stat-pending").textContent = assigns.length;

    // Build attendance lookup
    const attMap = {};
    if (att?.courses) att.courses.forEach(c => attMap[c.course_id] = c);

    const grid = $("#courses-grid");
    grid.innerHTML = "";
    courses.forEach(c => {
        const a = attMap[c.id];
        let attHtml = "";
        if (a && a.has_attendance && a.total_sessions > 0) {
            const cls = a.percentage >= 75 ? "att-good" : a.percentage >= 65 ? "att-warn" : "att-bad";
            attHtml = `<div class="cc-att"><span class="att-dot ${cls}"></span>${a.percentage}%  ·  ${a.present}P / ${a.absent}A</div>`;
        }

        const parts = c.name.split(" ");
        const code = /^[A-Z]{2,4}\d{3}/.test(parts[0]) ? parts[0] : "";
        const name = code ? parts.slice(1).join(" ") : c.name;

        const card = document.createElement("div");
        card.className = "course-card";
        card.innerHTML = `
            <div class="cc-code">${code}</div>
            <div class="cc-name">${name}</div>
            ${attHtml}
        `;
        grid.appendChild(card);
    });
}

/* ══════════════════════════════════════
   ATTENDANCE LIST + DETAIL
   ══════════════════════════════════════ */
function renderAttendanceList() {
    const list = $("#att-course-list");
    list.innerHTML = "";
    const courses = appData.attendance?.courses || [];

    if (courses.length === 0) {
        list.innerHTML = `<div class="empty-state">No attendance data available</div>`;
        return;
    }

    courses.forEach(c => {
        if (!c.has_attendance) return;
        const cls = c.percentage >= 75 ? "good" : c.percentage >= 65 ? "warn" : "bad";
        const row = document.createElement("div");
        row.className = "att-row";
        row.innerHTML = `
            <div class="att-info">
                <div class="att-name">${c.course_name}</div>
                <div class="att-meta">${c.present}P · ${c.absent}A · ${c.late}L — ${c.total_sessions} sessions</div>
            </div>
            <span class="att-pct ${cls}">${c.percentage}%</span>
            <span class="att-arrow">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="9 18 15 12 9 6"/></svg>
            </span>
        `;
        row.addEventListener("click", () => openCourseDetail(c));
        list.appendChild(row);
    });
}

function openCourseDetail(course) {
    $("#att-course-list").style.display = "none";
    const detail = $("#course-detail");
    detail.style.display = "block";

    const cls = course.percentage >= 75 ? "var(--green)" : course.percentage >= 65 ? "var(--amber)" : "var(--red)";

    $("#detail-header").innerHTML = `
        <div class="dh-name">${course.course_name}</div>
        <div class="dh-pct" style="color:${cls}">${course.percentage}%</div>
        <div class="dh-stats">
            <span class="dh-stat"><b>${course.present}</b> Present</span>
            <span class="dh-stat"><b>${course.absent}</b> Absent</span>
            <span class="dh-stat"><b>${course.late}</b> Late</span>
        </div>
    `;

    const sessions = course.sessions || [];
    const container = $("#detail-sessions");
    container.innerHTML = "";

    if (sessions.length === 0) {
        container.innerHTML = `<div class="empty-state">No session data</div>`;
        return;
    }

    // Show sessions newest first
    const sorted = [...sessions].reverse();
    sorted.forEach(s => {
        const statusLower = s.status.toLowerCase();
        let badgeCls = "present";
        if (statusLower.includes("absent")) badgeCls = "absent";
        else if (statusLower.includes("late")) badgeCls = "late";

        const row = document.createElement("div");
        row.className = "sess-row";
        row.innerHTML = `
            <span class="sess-date">${formatDate(s.date)}</span>
            <span class="sess-badge ${badgeCls}">${s.status}</span>
        `;
        container.appendChild(row);
    });
}

function formatDate(dateStr) {
    if (!dateStr) return "—";
    try {
        const d = new Date(dateStr + "T00:00:00");
        return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
    } catch { return dateStr; }
}

// Back button
$("#detail-back").addEventListener("click", () => {
    $("#course-detail").style.display = "none";
    $("#att-course-list").style.display = "";
});

/* ══════════════════════════════════════
   CALENDAR
   ══════════════════════════════════════ */
function buildSessionMap(courses) {
    sessionMap = {};
    if (!courses) return;
    courses.forEach(c => {
        (c.sessions || []).forEach(s => {
            if (!s.date) return;
            if (!sessionMap[s.date]) sessionMap[s.date] = [];
            sessionMap[s.date].push({
                course: c.course_name,
                status: s.status
            });
        });
    });
}

function renderCalendar() {
    const grid = $("#cal-grid");
    grid.innerHTML = "";

    const y = calMonth.getFullYear();
    const m = calMonth.getMonth();
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    $("#cal-month-year").textContent = `${months[m]} ${y}`;

    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const todayStr = new Date().toISOString().split("T")[0];

    for (let i = 0; i < firstDow; i++) {
        const e = document.createElement("div");
        e.className = "cal-cell empty";
        grid.appendChild(e);
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const ds = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const cell = document.createElement("div");
        cell.className = "cal-cell";
        if (ds === todayStr) cell.classList.add("today");

        const num = document.createElement("span");
        num.textContent = d;
        cell.appendChild(num);

        // Dots
        if (sessionMap[ds]) {
            const dots = document.createElement("span");
            dots.className = "dots";
            const statuses = sessionMap[ds].map(s => s.status.toLowerCase());
            const hasP = statuses.some(s => s.includes("present"));
            const hasA = statuses.some(s => s.includes("absent"));
            const hasL = statuses.some(s => s.includes("late"));
            if (hasP) { const i = document.createElement("i"); i.className = "dot-p"; dots.appendChild(i); }
            if (hasA) { const i = document.createElement("i"); i.className = "dot-a"; dots.appendChild(i); }
            if (hasL) { const i = document.createElement("i"); i.className = "dot-l"; dots.appendChild(i); }
            cell.appendChild(dots);
        }

        cell.addEventListener("click", () => showDayDetail(ds));
        grid.appendChild(cell);
    }
}

function showDayDetail(ds) {
    const box = $("#day-detail");
    const sessions = sessionMap[ds];
    if (!sessions || sessions.length === 0) {
        box.innerHTML = `<div class="dd-empty">No classes on ${formatDate(ds)}</div>`;
        return;
    }
    let html = `<div style="font-weight:600; margin-bottom:.5rem;">${formatDate(ds)}</div>`;
    sessions.forEach(s => {
        const sl = s.status.toLowerCase();
        const cls = sl.includes("absent") ? "absent" : sl.includes("late") ? "late" : "present";
        html += `<div class="dd-row">
            <span class="dd-course">${s.course}</span>
            <span class="sess-badge ${cls}">${s.status}</span>
        </div>`;
    });
    box.innerHTML = html;
}

$("#cal-prev").addEventListener("click", () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
$("#cal-next").addEventListener("click", () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });

/* ══════════════════════════════════════
   ASSIGNMENTS
   ══════════════════════════════════════ */
function renderAssignments() {
    const list = $("#assign-list");
    const assigns = appData.assignments?.assignments || [];
    list.innerHTML = "";

    if (assigns.length === 0) {
        list.innerHTML = `<div class="empty-state">No pending assignments 🎉</div>`;
        return;
    }

    assigns.forEach(a => {
        let dayStr = "--", monStr = "---";
        // "Tuesday, 18 February 2026, 11:59 PM"
        const parts = (a.due_date || "").split(" ");
        if (parts.length > 2) {
            dayStr = parts[1];
            monStr = (parts[2] || "").substring(0, 3).toUpperCase();
        }

        const card = document.createElement("div");
        card.className = "assign-card";
        card.innerHTML = `
            <div class="assign-date-box">
                <span class="adb-month">${monStr}</span>
                <span class="adb-day">${dayStr}</span>
            </div>
            <div class="assign-info">
                <div class="assign-title">${a.name}</div>
                <div class="assign-course">${a.course || ""}</div>
                <div class="assign-due">Due: ${a.due_date}</div>
            </div>
        `;
        list.appendChild(card);
    });
}

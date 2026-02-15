/**
 * LMS PRO — True Black Glass
 * Dashboard, Attendance Detail, Calendar, Assignments
 */

// Same-origin for web (both local and Vercel), full URL only for Capacitor/native
const API_BASE = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.hostname.includes("vercel.app")) ? "" : "https://lms-drab-chi.vercel.app";

/* ═══════ STATE ═══════ */
let authToken = null;
let appData = { dashboard: null, attendance: null, assignments: null };
let sessionMap = {};  // "YYYY-MM-DD" -> [{course, status, ...}]
let calMonth = new Date();
const BUNK_THRESHOLD = 0.80; // 80% attendance requirement

/* ═══════ AES-GCM ENCRYPTION (Web Crypto API) ═══════ */
const APP_PEPPER = "LMS-Pro-Syndicate-2026";
const STORAGE_KEYS = { user: "lms_user", cred: "lms_cred", salt: "lms_salt" };

async function deriveKey(username, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw", enc.encode(username + APP_PEPPER),
        "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false, ["encrypt", "decrypt"]
    );
}

async function encryptAndStore(username, password) {
    try {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await deriveKey(username, salt);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const enc = new TextEncoder();
        const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv }, key, enc.encode(password)
        );
        // Store as base64
        const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
        localStorage.setItem(STORAGE_KEYS.user, username);
        localStorage.setItem(STORAGE_KEYS.salt, b64(salt));
        localStorage.setItem(STORAGE_KEYS.cred, b64(iv) + ":" + b64(ciphertext));
    } catch (e) {
        console.warn("Failed to encrypt credentials:", e);
    }
}

async function decryptStored() {
    try {
        const username = localStorage.getItem(STORAGE_KEYS.user);
        const saltB64 = localStorage.getItem(STORAGE_KEYS.salt);
        const credB64 = localStorage.getItem(STORAGE_KEYS.cred);
        if (!username || !saltB64 || !credB64) return null;

        const b64decode = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
        const salt = b64decode(saltB64);
        const [ivB64, ctB64] = credB64.split(":");
        const iv = b64decode(ivB64);
        const ciphertext = b64decode(ctB64);

        const key = await deriveKey(username, salt);
        const plainBuf = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv }, key, ciphertext
        );
        const password = new TextDecoder().decode(plainBuf);
        return { username, password };
    } catch (e) {
        console.warn("Failed to decrypt credentials:", e);
        clearStoredCredentials();
        return null;
    }
}

function clearStoredCredentials() {
    Object.values(STORAGE_KEYS).forEach(k => localStorage.removeItem(k));
}

/* ═══════ BUNK CALCULATOR ═══════ */
function getBunkInfo(present, total) {
    if (total === 0) return null;
    const pct = present / total;
    if (pct >= BUNK_THRESHOLD) {
        // How many can be skipped: floor((present - threshold*total) / threshold)
        const canSkip = Math.floor((present - BUNK_THRESHOLD * total) / BUNK_THRESHOLD);
        if (canSkip <= 0) return { type: "perfect", text: "⚠️ Don't skip any more" };
        return { type: "safe", text: `Can skip ${canSkip} more class${canSkip > 1 ? "es" : ""}` };
    } else {
        // How many must attend: ceil((threshold*total - present) / (1-threshold))
        const mustAttend = Math.ceil((BUNK_THRESHOLD * total - present) / (1 - BUNK_THRESHOLD));
        return { type: "danger", text: `Attend next ${mustAttend} to reach 80%` };
    }
}

/* ═══════ HELPERS ═══════ */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function authHeaders() {
    // Token-only headers (no body)
    const h = {};
    if (authToken) h["Authorization"] = `Bearer ${authToken}`;
    return h;
}

function jsonHeaders() {
    // For requests WITH a JSON body
    return {
        "Content-Type": "application/json",
        ...authHeaders()
    };
}

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
        await performLogin(u, p);

        // Save encrypted credentials if "Remember Me" is checked
        const rememberMe = $("#remember-me");
        if (rememberMe && rememberMe.checked) {
            await encryptAndStore(u, p);
        }
    } catch (err) {
        overlay.classList.remove("active");
        $("#login-error").textContent = err.message || "Connection failed";
        authToken = null;
    } finally {
        btn.classList.remove("loading");
    }
});

/**
 * Core login + data fetch logic. Used by both manual login and auto-login.
 */
async function performLogin(u, p) {
    // 1. Login — credentials sent only once
    const loginR = await fetch(`${API_BASE}/login`, {
        method: "POST", headers: jsonHeaders(),
        body: JSON.stringify({ username: u, password: p })
    });
    const loginData = await loginR.json();
    if (!loginR.ok) throw new Error(loginData.detail || "Login failed");

    authToken = loginData.token;
    // Clear password from form immediately
    $("#password").value = "";

    setStep("step-login", "done");
    setStep("step-courses", "active");

    // 2. Single combined fetch — dashboard + attendance + assignments in one call
    const allR = await fetch(`${API_BASE}/scrape/all`, {
        method: "POST", headers: authHeaders()
    });

    // Animate steps while we parse
    setStep("step-courses", "done");
    setStep("step-att", "active");
    setStep("step-assign", "active");

    const allData = await allR.json();
    if (!allR.ok) throw new Error(typeof allData.detail === "string" ? allData.detail : "Data fetch failed");

    // Unpack combined response
    appData.dashboard = { success: true, courses: allData.courses, user_name: allData.user_name };

    if (allData.attendance?.courses) {
        appData.attendance = allData.attendance;
        buildSessionMap(allData.attendance.courses);
    }
    setStep("step-att", "done");

    if (allData.assignments) {
        appData.assignments = { assignments: allData.assignments };
    }
    setStep("step-assign", "done");

    await sleep(300);

    // Build UI
    renderDashboard();
    renderAttendanceList();
    renderCalendar();
    renderAssignments();

    overlay.classList.remove("active");
    loginScreen.classList.remove("active");
    appScreen.classList.add("active");
    $("#user-initials").textContent = (allData.user_name || u).charAt(0).toUpperCase();
}

/* ═══════ LOGOUT ═══════ */
$("#logout-btn").addEventListener("click", () => {
    authToken = null;
    appData = { dashboard: null, attendance: null, assignments: null };
    sessionMap = {};
    clearStoredCredentials();
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
    statEl.style.color = overall >= 80 ? "var(--green)" : overall >= 70 ? "var(--amber)" : "var(--red)";
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
            const cls = a.percentage >= 80 ? "att-good" : a.percentage >= 70 ? "att-warn" : "att-bad";
            const bunk = getBunkInfo(a.present, a.total_sessions);
            const bunkTag = bunk ? ` <span class="bunk-info bunk-${bunk.type}" style="font-size:.65rem;padding:.1rem .4rem;margin-left:.3rem">${bunk.text}</span>` : "";
            attHtml = `<div class="cc-att"><span class="att-dot ${cls}"></span>${a.percentage}%  ·  ${a.present}P / ${a.absent}A${bunkTag}</div>`;
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
        const cls = c.percentage >= 80 ? "good" : c.percentage >= 70 ? "warn" : "bad";
        const bunk = getBunkInfo(c.present, c.total_sessions);
        const bunkHtml = bunk ? `<div class="bunk-info bunk-${bunk.type}">${bunk.text}</div>` : "";
        const row = document.createElement("div");
        row.className = "att-row";
        row.innerHTML = `
            <div class="att-info">
                <div class="att-name">${c.course_name}</div>
                <div class="att-meta">${c.present}P · ${c.absent}A · ${c.late}L — ${c.total_sessions} sessions</div>
                ${bunkHtml}
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

    const cls = course.percentage >= 80 ? "var(--green)" : course.percentage >= 70 ? "var(--amber)" : "var(--red)";

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

/* ═══════ AUTO-LOGIN ON PAGE LOAD ═══════ */
(async function autoLogin() {
    const stored = await decryptStored();
    if (!stored) return; // No saved credentials, show login screen normally

    // Show auto-login overlay
    const autoOverlay = document.createElement("div");
    autoOverlay.className = "auto-login-overlay";
    autoOverlay.innerHTML = `
        <div class="loading-ring"></div>
        <p>Signing you in...</p>
    `;
    document.body.appendChild(autoOverlay);

    // Also activate the step overlay for progress
    const overlay = $("#loading-overlay");
    overlay.classList.add("active");
    setStep("step-login", "active");

    try {
        await performLogin(stored.username, stored.password);
        // Re-encrypt to rotate salt/IV (defense in depth)
        await encryptAndStore(stored.username, stored.password);
    } catch (e) {
        console.warn("Auto-login failed:", e.message);
        clearStoredCredentials();
        overlay.classList.remove("active");
        // Show login screen normally
        loginScreen.classList.add("active");
    } finally {
        autoOverlay.remove();
    }
})();

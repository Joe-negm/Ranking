// ============================================================================
// Cambridge Math Arena — Frontend Application (Vanilla JS + Supabase v2)
// ============================================================================

// Option A: Hardcode your Supabase credentials here
const DEFAULT_SUPABASE_URL = "https://yktszhisgtrzggorhzwo.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrdHN6aGlzZ3Ryemdnb3JoendvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ4MjYzOTAsImV4cCI6MjExMDQwMjM5MH0.jKaihUD8OoFyQe7hEF8VPytPQg6PfZx0ir6rNJqEwbE";

// Synthetic domain used so students can log in with Username + Password only
const STUDENT_EMAIL_DOMAIN = "student.cambridgemath.local";

let supabaseClient = null;
let studentSignupClient = null; // Non-persisted client so Teacher stays logged in when adding students
let currentUser = null;
let currentProfile = null;

// App caches
let allTopics = [];
let allQuestions = [];
let mySolvedQuestionIds = new Set();
let pendingAnswerChips = [];
let activeTopicId = null;
let teacherStudentsCache = [];
let globalStudentsCache = [];

// ============================================================================
// INITIALIZATION & SUPABASE CONNECTION
// ============================================================================
function getSupabaseConfig() {
  const url = DEFAULT_SUPABASE_URL || localStorage.getItem("cm_supabase_url") || "";
  const key = DEFAULT_SUPABASE_ANON_KEY || localStorage.getItem("cm_supabase_key") || "";
  return { url: url.trim(), key: key.trim() };
}

function initSupabase() {
  const { url, key } = getSupabaseConfig();
  const banner = document.getElementById("config-banner");

  if (!url || !key) {
    banner.classList.remove("hidden");
    return false;
  }

  banner.classList.add("hidden");
  const { createClient } = window.supabase;

  supabaseClient = createClient(url, key);
  studentSignupClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return true;
}

document.addEventListener("DOMContentLoaded", async () => {
  bindStaticEvents();
  if (initSupabase()) {
    await checkSessionAndBoot();
  }
});

// ============================================================================
// TOASTS & HELPERS
// ============================================================================
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function usernameToEmail(username) {
  const clean = username.trim().toLowerCase().replace(/[^a-z0-9_.]/g, "");
  return { clean, email: `${clean}@${STUDENT_EMAIL_DOMAIN}` };
}

function isTeacherSubscriptionActive(profile) {
  if (!profile) return false;
  if (profile.subscription_waived) return true;
  if (!profile.trial_ends_at) return false;
  return new Date(profile.trial_ends_at) > new Date();
}

function daysLeftInTrial(trialEndsAt) {
  if (!trialEndsAt) return 0;
  const diff = new Date(trialEndsAt) - new Date();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// ============================================================================
// AUTHENTICATION & SESSION BOOTSTRAPPING
// ============================================================================
async function checkSessionAndBoot() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    showAuthView();
    return;
  }

  currentUser = session.user;
  const { data: profile, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  if (error || !profile) {
    showToast("Could not load profile. Please sign in again.", "error");
    await supabaseClient.auth.signOut();
    showAuthView();
    return;
  }

  currentProfile = profile;
  await bootRoleWorkspace();
}

function showAuthView() {
  currentUser = null;
  currentProfile = null;
  document.getElementById("auth-section").classList.remove("hidden");
  document.getElementById("app-section").classList.add("hidden");
}

async function bootRoleWorkspace() {
  document.getElementById("auth-section").classList.add("hidden");
  document.getElementById("app-section").classList.remove("hidden");

  // Populate header
  const roleBadge = document.getElementById("header-role-badge");
  roleBadge.textContent = currentProfile.role.toUpperCase();
  roleBadge.className = `badge badge-${currentProfile.role}`;

  document.getElementById("header-user-name").textContent = currentProfile.full_name;
  document.getElementById("header-school-badge").textContent =
    currentProfile.school_name || (currentProfile.role === "owner" ? "Platform Owner" : "");

  const scorePill = document.getElementById("header-score-badge");
  if (currentProfile.role === "student") {
    scorePill.textContent = `${currentProfile.score} pts`;
    scorePill.classList.remove("hidden");
  } else {
    scorePill.classList.add("hidden");
  }

  // Build role-based navigation
  const nav = document.getElementById("main-nav");
  let tabs = [];
  if (currentProfile.role === "owner") {
    tabs = [
      { id: "owner-questions", label: "🖼️ Questions & Topics" },
      { id: "owner-teachers", label: "👩‍🏫 Teachers & Waivers" },
      { id: "global-dashboard", label: "🌍 All Students Dashboard" },
    ];
  } else if (currentProfile.role === "teacher") {
    tabs = [
      { id: "teacher-class", label: "🏫 Class Dashboard & Students" },
      { id: "global-dashboard", label: "🌍 All Students Dashboard" },
    ];
  } else {
    tabs = [
      { id: "student-practice", label: "📐 Practice Topics" },
      { id: "class-dashboard", label: "🏫 Class Dashboard" },
      { id: "global-dashboard", label: "🌍 All Students Dashboard" },
    ];
  }

  nav.innerHTML = tabs
    .map((t, i) => `<button class="nav-btn ${i === 0 ? "active" : ""}" data-view="${t.id}">${t.label}</button>`)
    .join("");

  nav.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchWorkspaceView(btn.dataset.view));
  });

  await switchWorkspaceView(tabs[0].id);
}

async function switchWorkspaceView(viewId) {
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === viewId);
  });
  document.querySelectorAll(".view-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `view-${viewId}`);
  });

  if (viewId === "owner-questions") await loadOwnerQuestionsView();
  if (viewId === "owner-teachers") await loadOwnerTeachersView();
  if (viewId === "teacher-class") await loadTeacherClassView();
  if (viewId === "student-practice") await loadStudentPracticeView();
  if (viewId === "class-dashboard") await loadStudentClassDashboard();
  if (viewId === "global-dashboard") await loadGlobalDashboard();
}

// ============================================================================
// BIND STATIC DOM EVENTS
// ============================================================================
function bindStaticEvents() {
  // Auth tab switching
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".auth-form").forEach((f) => f.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`${tab.dataset.authTab}-form`).classList.add("active");
    });
  });

  // Config modal controls
  const openConfig = () => {
    const { url, key } = getSupabaseConfig();
    document.getElementById("supabase-url-input").value = url;
    document.getElementById("supabase-key-input").value = key;
    document.getElementById("config-modal").classList.remove("hidden");
  };
  document.getElementById("open-config-btn").addEventListener("click", openConfig);
  document.getElementById("auth-config-trigger").addEventListener("click", openConfig);
  document.getElementById("close-config-modal").addEventListener("click", () => {
    document.getElementById("config-modal").classList.add("hidden");
  });

  document.getElementById("config-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = document.getElementById("supabase-url-input").value.trim();
    const key = document.getElementById("supabase-key-input").value.trim();
    localStorage.setItem("cm_supabase_url", url);
    localStorage.setItem("cm_supabase_key", key);
    document.getElementById("config-modal").classList.add("hidden");
    if (initSupabase()) {
      showToast("Supabase connected!", "success");
      await checkSessionAndBoot();
    }
  });

  // Student Login (Username + Password)
  document.getElementById("student-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!supabaseClient) return showToast("Connect Supabase first.", "error");
    const rawUsername = document.getElementById("student-username").value;
    const password = document.getElementById("student-password").value;
    const { clean, email } = usernameToEmail(rawUsername);

    if (!clean) return showToast("Enter a valid username.", "error");

    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) return showToast("Invalid username or password.", "error");
    showToast("Welcome back!", "success");
    await checkSessionAndBoot();
  });

  // Teacher / Owner Login
  document.getElementById("staff-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!supabaseClient) return showToast("Connect Supabase first.", "error");
    const email = document.getElementById("staff-email").value.trim();
    const password = document.getElementById("staff-password").value;

    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) return showToast(error.message, "error");
    showToast("Signed in successfully!", "success");
    await checkSessionAndBoot();
  });

  // Teacher Sign Up (Starts 30-day free trial)
  document.getElementById("teacher-signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!supabaseClient) return showToast("Connect Supabase first.", "error");

    const fullName = document.getElementById("teacher-name").value.trim();
    const schoolName = document.getElementById("teacher-school").value.trim();
    const email = document.getElementById("teacher-email").value.trim();
    const password = document.getElementById("teacher-password").value;

    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: { role: "teacher", full_name: fullName, school_name: schoolName },
      },
    });

    if (error) return showToast(error.message, "error");
    if (data.session) {
      showToast("Teacher account created! 1-month free trial active.", "success");
      await checkSessionAndBoot();
    } else {
      showToast("Account created! Please confirm your email or disable email confirmation in Supabase.", "info");
    }
  });

  // Sign Out
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    showToast("Signed out.", "info");
    showAuthView();
  });

  // Owner: Image preview & Answer chips
  document.getElementById("q-image-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    const wrap = document.getElementById("q-image-preview-wrap");
    if (!file) return wrap.classList.add("hidden");
    document.getElementById("q-image-preview").src = URL.createObjectURL(file);
    wrap.classList.remove("hidden");
  });

  document.getElementById("add-answer-chip-btn").addEventListener("click", addPendingAnswerFromInput);
  document.getElementById("q-answer-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addPendingAnswerFromInput();
    }
  });

  // Owner: Create Topic
  document.getElementById("add-topic-form").addEventListener("submit", handleOwnerCreateTopic);
  // Owner: Publish Question
  document.getElementById("add-question-form").addEventListener("submit", handleOwnerPublishQuestion);
  document.getElementById("owner-questions-filter-topic").addEventListener("change", renderOwnerQuestions);

  // Teacher: Create Student & Search
  document.getElementById("create-student-form").addEventListener("submit", handleTeacherCreateStudent);
  document.getElementById("teacher-class-search").addEventListener("input", renderTeacherClassTable);

  // Student: Topic Back & Filter
  document.getElementById("back-to-topics-btn").addEventListener("click", () => {
    activeTopicId = null;
    document.getElementById("student-topic-questions-area").classList.add("hidden");
    document.getElementById("student-topics-grid").classList.remove("hidden");
  });
  document.getElementById("student-q-filter").addEventListener("change", renderStudentTopicQuestions);

  // Global Leaderboard Search
  document.getElementById("global-search").addEventListener("input", renderGlobalLeaderboard);

  // Image Zoom Lightbox
  document.getElementById("close-image-modal").addEventListener("click", () => {
    document.getElementById("image-modal").classList.add("hidden");
  });
  document.querySelector("#image-modal .modal-backdrop").addEventListener("click", () => {
    document.getElementById("image-modal").classList.add("hidden");
  });
}

function openImageZoom(url) {
  document.getElementById("modal-img").src = url;
  document.getElementById("image-modal").classList.remove("hidden");
}

// ============================================================================
// OWNER PORTAL: TOPICS & IMAGE QUESTIONS
// ============================================================================
function addPendingAnswerFromInput() {
  const input = document.getElementById("q-answer-input");
  const raw = input.value.trim();
  if (!raw) return;

  raw.split(",").map((s) => s.trim()).filter(Boolean).forEach((ans) => {
    if (!pendingAnswerChips.includes(ans)) pendingAnswerChips.push(ans);
  });

  input.value = "";
  renderAnswerChips();
}

function renderAnswerChips() {
  const container = document.getElementById("q-answers-chips");
  container.innerHTML = pendingAnswerChips
    .map(
      (ans, idx) => `
      <span class="answer-chip">
        ${escapeHtml(ans)}
        <button type="button" data-idx="${idx}" title="Remove">&times;</button>
      </span>`
    )
    .join("");

  container.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      pendingAnswerChips.splice(Number(btn.dataset.idx), 1);
      renderAnswerChips();
    });
  });
}

async function loadOwnerQuestionsView() {
  const [{ data: topics }, { data: questions }, { data: answers }] = await Promise.all([
    supabaseClient.from("topics").select("*").order("name"),
    supabaseClient.from("questions").select("*").order("created_at", { ascending: false }),
    supabaseClient.from("question_answers").select("*"),
  ]);

  allTopics = topics || [];
  const answerMap = new Map((answers || []).map((a) => [a.question_id, a.accepted_answers]));
  allQuestions = (questions || []).map((q) => ({
    ...q,
    accepted_answers: answerMap.get(q.id) || [],
  }));

  // Populate dropdowns
  const qTopicSelect = document.getElementById("q-topic");
  const filterSelect = document.getElementById("owner-questions-filter-topic");

  qTopicSelect.innerHTML = allTopics
    .map((t) => `<option value="${t.id}">${escapeHtml(t.icon)} ${escapeHtml(t.name)}</option>`)
    .join("");

  filterSelect.innerHTML =
    `<option value="all">All Topics</option>` +
    allTopics.map((t) => `<option value="${t.id}">${escapeHtml(t.icon)} ${escapeHtml(t.name)}</option>`).join("");

  // Render mini topics list
  document.getElementById("owner-topics-list").innerHTML = allTopics
    .map(
      (t) => `
      <div class="topic-mini-item">
        <div>
          <strong>${escapeHtml(t.icon)} ${escapeHtml(t.name)}</strong>
          <div class="muted">${escapeHtml(t.stage_group)}</div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="deleteTopic('${t.id}')">Delete</button>
      </div>`
    )
    .join("");

  renderOwnerQuestions();
}

async function handleOwnerCreateTopic(e) {
  e.preventDefault();
  const name = document.getElementById("topic-name").value.trim();
  const icon = document.getElementById("topic-icon").value.trim() || "📐";
  const stage_group = document.getElementById("topic-stage").value.trim();
  const description = document.getElementById("topic-desc").value.trim();

  const { error } = await supabaseClient
    .from("topics")
    .insert({ name, icon, stage_group, description });

  if (error) return showToast(error.message, "error");
  showToast(`Topic "${name}" created!`, "success");
  e.target.reset();
  document.getElementById("topic-icon").value = "📏";
  document.getElementById("topic-stage").value = "Primary & Lower Secondary";
  await loadOwnerQuestionsView();
}

window.deleteTopic = async function (topicId) {
  if (!confirm("Delete this topic and all its questions?")) return;
  const { error } = await supabaseClient.from("topics").delete().eq("id", topicId);
  if (error) return showToast(error.message, "error");
  showToast("Topic deleted.", "info");
  await loadOwnerQuestionsView();
};

async function handleOwnerPublishQuestion(e) {
  e.preventDefault();
  // Include any un-added text remaining in the answer input
  addPendingAnswerFromInput();

  if (pendingAnswerChips.length === 0) {
    return showToast("Please add at least one accepted answer.", "error");
  }

  const file = document.getElementById("q-image-file").files[0];
  if (!file) return showToast("Please choose a question image.", "error");

  const btn = document.getElementById("publish-question-btn");
  btn.disabled = true;
  btn.textContent = "Uploading Image...";

  try {
    const ext = file.name.split(".").pop() || "png";
    const filePath = `questions/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadError } = await supabaseClient.storage
      .from("question-images")
      .upload(filePath, file, { cacheControl: "3600", upsert: false });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabaseClient.storage
      .from("question-images")
      .getPublicUrl(filePath);

    const { error: rpcError } = await supabaseClient.rpc("owner_create_question", {
      p_topic_id: document.getElementById("q-topic").value,
      p_title: document.getElementById("q-title").value.trim(),
      p_stage: document.getElementById("q-stage").value,
      p_image_url: urlData.publicUrl,
      p_points: Number(document.getElementById("q-points").value) || 10,
      p_accepted_answers: pendingAnswerChips,
    });

    if (rpcError) throw rpcError;

    showToast("Question published to the platform!", "success");
    e.target.reset();
    pendingAnswerChips = [];
    renderAnswerChips();
    document.getElementById("q-image-preview-wrap").classList.add("hidden");
    await loadOwnerQuestionsView();
  } catch (err) {
    showToast(err.message || "Failed to publish question.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Publish Question";
  }
}

function renderOwnerQuestions() {
  const filterId = document.getElementById("owner-questions-filter-topic").value;
  const topicMap = new Map(allTopics.map((t) => [t.id, t]));
  const filtered = filterId === "all" ? allQuestions : allQuestions.filter((q) => q.topic_id === filterId);

  const container = document.getElementById("owner-questions-list");
  if (filtered.length === 0) {
    container.innerHTML = `<p class="muted">No questions uploaded yet for this filter.</p>`;
    return;
  }

  container.innerHTML = filtered
    .map((q) => {
      const topic = topicMap.get(q.topic_id);
      return `
      <div class="question-card">
        <div class="question-img-box" onclick="openImageZoom('${escapeHtml(q.image_url)}')">
          <img src="${escapeHtml(q.image_url)}" alt="${escapeHtml(q.title)}" />
        </div>
        <div class="question-body">
          <div class="question-meta">
            <span class="stage-tag">${escapeHtml(q.stage)}</span>
            <span class="points-tag">${q.points} pts</span>
          </div>
          <strong>${escapeHtml(q.title)}</strong>
          <small class="muted">${topic ? `${escapeHtml(topic.icon)} ${escapeHtml(topic.name)}` : ""}</small>
          <div class="chips-container">
            ${(q.accepted_answers || []).map((a) => `<span class="answer-chip">${escapeHtml(a)}</span>`).join("")}
          </div>
          <button class="btn btn-danger btn-sm mt-lg" onclick="deleteQuestion('${q.id}')">Delete Question</button>
        </div>
      </div>`;
    })
    .join("");
}

window.openImageZoom = openImageZoom;

window.deleteQuestion = async function (questionId) {
  if (!confirm("Delete this question?")) return;
  const { error } = await supabaseClient.from("questions").delete().eq("id", questionId);
  if (error) return showToast(error.message, "error");
  showToast("Question deleted.", "info");
  await loadOwnerQuestionsView();
};

// ============================================================================
// OWNER PORTAL: TEACHERS & SUBSCRIPTION WAIVERS
// ============================================================================
async function loadOwnerTeachersView() {
  const { data: profiles, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .in("role", ["teacher", "student"])
    .order("created_at", { ascending: false });

  if (error) return showToast(error.message, "error");

  const teachers = (profiles || []).filter((p) => p.role === "teacher");
  const students = (profiles || []).filter((p) => p.role === "student");

  const studentCounts = {};
  students.forEach((s) => {
    studentCounts[s.teacher_id] = (studentCounts[s.teacher_id] || 0) + 1;
  });

  document.getElementById("owner-stat-teachers").textContent = teachers.length;
  document.getElementById("owner-stat-waived").textContent = teachers.filter((t) => t.subscription_waived).length;
  document.getElementById("owner-stat-students").textContent = students.length;

  const tbody = document.getElementById("owner-teachers-tbody");
  if (teachers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No teachers registered yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = teachers
    .map((t) => {
      const days = daysLeftInTrial(t.trial_ends_at);
      let statusBadge = "";
      if (t.subscription_waived) {
        statusBadge = `<span class="badge badge-success">Fee Waived</span>`;
      } else if (days > 0) {
        statusBadge = `<span class="badge badge-warning">Trial (${days}d left)</span>`;
      } else {
        statusBadge = `<span class="badge badge-danger">Trial Expired</span>`;
      }

      const trialDate = t.trial_ends_at ? new Date(t.trial_ends_at).toLocaleDateString() : "—";

      return `
      <tr>
        <td>
          <strong>${escapeHtml(t.full_name)}</strong><br/>
          <small class="muted">${escapeHtml(t.email || "")}</small>
        </td>
        <td>${escapeHtml(t.school_name || "—")}</td>
        <td>${studentCounts[t.id] || 0}</td>
        <td>${trialDate}</td>
        <td>${statusBadge}</td>
        <td>
          <button
            class="btn btn-sm ${t.subscription_waived ? "btn-outline" : "btn-amber"}"
            onclick="toggleWaiveSubscription('${t.id}', ${!t.subscription_waived})"
          >
            ${t.subscription_waived ? "Revoke Waiver" : "Waive Subscription Fee"}
          </button>
        </td>
      </tr>`;
    })
    .join("");
}

window.toggleWaiveSubscription = async function (teacherId, waive) {
  const { error } = await supabaseClient
    .from("profiles")
    .update({ subscription_waived: waive })
    .eq("id", teacherId);

  if (error) return showToast(error.message, "error");
  showToast(waive ? "Subscription fee waived for teacher!" : "Subscription waiver removed.", "success");
  await loadOwnerTeachersView();
};

// ============================================================================
// TEACHER PORTAL: STUDENT ACCOUNTS & TEACHER CLASS DASHBOARD
// ============================================================================
async function loadTeacherClassView() {
  // Refresh teacher profile to get latest waiver/trial status
  const { data: freshProfile } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", currentProfile.id)
    .single();
  if (freshProfile) currentProfile = freshProfile;

  // Pre-fill school name in student creation form
  const schoolInput = document.getElementById("new-student-school");
  if (!schoolInput.value) schoolInput.value = currentProfile.school_name || "";

  // Render trial / subscription banner
  const banner = document.getElementById("teacher-trial-banner");
  const active = isTeacherSubscriptionActive(currentProfile);
  const days = daysLeftInTrial(currentProfile.trial_ends_at);

  if (currentProfile.subscription_waived) {
    banner.className = "trial-banner trial-waived";
    banner.innerHTML = `<span>✅ Subscription Fee Waived by Owner — Full Lifetime Teacher Access</span>`;
  } else if (active) {
    banner.className = "trial-banner trial-active";
    banner.innerHTML = `<span>🎁 1-Month Free Trial Active: <strong>${days} day(s) remaining</strong> (ends ${new Date(currentProfile.trial_ends_at).toLocaleDateString()})</span>`;
  } else {
    banner.className = "trial-banner trial-expired";
    banner.innerHTML = `<span>⚠️ Your 1-month free trial has expired. Ask the platform Owner to waive your subscription fee to register more students.</span>`;
  }

  document.getElementById("create-student-btn").disabled = !active;

  // Fetch teacher's students ranked by score
  const { data: students, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("role", "student")
    .eq("teacher_id", currentProfile.id)
    .order("score", { ascending: false })
    .order("questions_solved", { ascending: false });

  if (error) return showToast(error.message, "error");

  teacherStudentsCache = students || [];
  const count = teacherStudentsCache.length;
  const totalScore = teacherStudentsCache.reduce((acc, s) => acc + (s.score || 0), 0);
  const topScore = count > 0 ? teacherStudentsCache[0].score : 0;

  document.getElementById("teacher-stat-count").textContent = count;
  document.getElementById("teacher-stat-avg").textContent = count ? Math.round(totalScore / count) : 0;
  document.getElementById("teacher-stat-top").textContent = topScore;

  renderTeacherClassTable();
}

function renderTeacherClassTable() {
  const query = document.getElementById("teacher-class-search").value.trim().toLowerCase();
  const tbody = document.getElementById("teacher-class-tbody");

  const ranked = teacherStudentsCache.map((s, i) => ({ ...s, rank: i + 1 }));
  const filtered = query
    ? ranked.filter(
        (s) =>
          s.full_name.toLowerCase().includes(query) ||
          (s.username || "").toLowerCase().includes(query) ||
          (s.school_name || "").toLowerCase().includes(query)
      )
    : ranked;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No students found in your class yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map(
      (s) => `
      <tr>
        <td><strong>${formatRankMedal(s.rank)}</strong></td>
        <td>${escapeHtml(s.full_name)}</td>
        <td><code>${escapeHtml(s.username || "")}</code></td>
        <td>${escapeHtml(s.school_name || "—")}</td>
        <td>${s.questions_solved}</td>
        <td><strong>${s.score} pts</strong></td>
      </tr>`
    )
    .join("");
}

async function handleTeacherCreateStudent(e) {
  e.preventDefault();
  if (!isTeacherSubscriptionActive(currentProfile)) {
    return showToast("Your trial has expired. Ask the Owner to waive your fee.", "error");
  }

  const fullName = document.getElementById("new-student-name").value.trim();
  const rawUsername = document.getElementById("new-student-username").value;
  const password = document.getElementById("new-student-password").value;
  const schoolName = document.getElementById("new-student-school").value.trim();
  const { clean, email } = usernameToEmail(rawUsername);

  if (clean.length < 3) {
    return showToast("Username must be at least 3 alphanumeric/underscore characters.", "error");
  }

  const btn = document.getElementById("create-student-btn");
  btn.disabled = true;
  btn.textContent = "Creating Account...";

  try {
    // Check username availability first
    const { data: existing } = await supabaseClient
      .from("profiles")
      .select("id")
      .eq("username", clean)
      .maybeSingle();

    if (existing) {
      throw new Error(`Username "${clean}" is already taken. Choose another.`);
    }

    const { error } = await studentSignupClient.auth.signUp({
      email,
      password,
      options: {
        data: {
          role: "student",
          full_name: fullName,
          username: clean,
          school_name: schoolName,
          teacher_id: currentProfile.id,
        },
      },
    });

    if (error) throw error;

    showToast(`Student "${fullName}" created! Login username: ${clean}`, "success");
    e.target.reset();
    document.getElementById("new-student-school").value = currentProfile.school_name || "";
    await loadTeacherClassView();
  } catch (err) {
    showToast(err.message || "Could not create student.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Student Account";
  }
}

// ============================================================================
// STUDENT PORTAL: TOPICS, IMAGE QUESTIONS & SUBMITTING ANSWERS
// ============================================================================
async function loadStudentPracticeView() {
  const [{ data: topics }, { data: questions }, { data: attempts }, { data: freshProfile }] = await Promise.all([
    supabaseClient.from("topics").select("*").order("name"),
    supabaseClient.from("questions").select("*").order("created_at", { ascending: true }),
    supabaseClient
      .from("student_attempts")
      .select("question_id, is_correct")
      .eq("student_id", currentProfile.id)
      .eq("is_correct", true),
    supabaseClient.from("profiles").select("score, questions_solved").eq("id", currentProfile.id).single(),
  ]);

  if (freshProfile) {
    currentProfile.score = freshProfile.score;
    currentProfile.questions_solved = freshProfile.questions_solved;
  }

  document.getElementById("student-my-score").textContent = currentProfile.score;
  document.getElementById("student-my-solved").textContent = currentProfile.questions_solved;
  document.getElementById("header-score-badge").textContent = `${currentProfile.score} pts`;

  allTopics = topics || [];
  allQuestions = questions || [];
  mySolvedQuestionIds = new Set((attempts || []).map((a) => a.question_id));

  renderStudentTopicsGrid();
  if (activeTopicId) renderStudentTopicQuestions();
}

function renderStudentTopicsGrid() {
  const grid = document.getElementById("student-topics-grid");
  if (allTopics.length === 0) {
    grid.innerHTML = `<p class="muted">No topics available yet. Ask the platform owner to add topics!</p>`;
    return;
  }

  grid.innerHTML = allTopics
    .map((topic) => {
      const topicQuestions = allQuestions.filter((q) => q.topic_id === topic.id);
      const solvedCount = topicQuestions.filter((q) => mySolvedQuestionIds.has(q.id)).length;
      return `
      <div class="topic-card" onclick="openStudentTopic('${topic.id}')">
        <div class="topic-icon">${escapeHtml(topic.icon)}</div>
        <h3>${escapeHtml(topic.name)}</h3>
        <p>${escapeHtml(topic.description || topic.stage_group)}</p>
        <div class="topic-progress">
          <span>${topicQuestions.length} Question(s)</span>
          <span>✅ ${solvedCount} Solved</span>
        </div>
      </div>`;
    })
    .join("");
}

window.openStudentTopic = function (topicId) {
  activeTopicId = topicId;
  const topic = allTopics.find((t) => t.id === topicId);
  document.getElementById("active-topic-heading").textContent = topic
    ? `${topic.icon} ${topic.name}`
    : "Topic Questions";

  document.getElementById("student-topics-grid").classList.add("hidden");
  document.getElementById("student-topic-questions-area").classList.remove("hidden");
  renderStudentTopicQuestions();
};

function renderStudentTopicQuestions() {
  const filter = document.getElementById("student-q-filter").value;
  let questions = allQuestions.filter((q) => q.topic_id === activeTopicId);

  if (filter === "solved") questions = questions.filter((q) => mySolvedQuestionIds.has(q.id));
  if (filter === "unsolved") questions = questions.filter((q) => !mySolvedQuestionIds.has(q.id));

  const container = document.getElementById("student-questions-list");
  if (questions.length === 0) {
    container.innerHTML = `<p class="muted">No questions match this filter in this topic.</p>`;
    return;
  }

  container.innerHTML = questions
    .map((q) => {
      const isSolved = mySolvedQuestionIds.has(q.id);
      return `
      <div class="question-card ${isSolved ? "solved" : ""}" id="q-card-${q.id}">
        <div class="question-img-box" onclick="openImageZoom('${escapeHtml(q.image_url)}')" title="Click to zoom">
          <img src="${escapeHtml(q.image_url)}" alt="${escapeHtml(q.title)}" />
        </div>
        <div class="question-body">
          <div class="question-meta">
            <span class="stage-tag">${escapeHtml(q.stage)}</span>
            <span class="points-tag">${isSolved ? "✅ Solved" : `+${q.points} pts`}</span>
          </div>
          <strong>${escapeHtml(q.title)}</strong>
          <form class="student-answer-row" onsubmit="handleStudentSubmitAnswer(event, '${q.id}')">
            <input type="text" id="ans-input-${q.id}" placeholder="Enter your answer..." required />
            <button type="submit" class="btn btn-primary btn-sm">Check</button>
          </form>
          <div id="feedback-${q.id}" class="attempt-feedback hidden"></div>
        </div>
      </div>`;
    })
    .join("");
}

window.handleStudentSubmitAnswer = async function (e, questionId) {
  e.preventDefault();
  const input = document.getElementById(`ans-input-${questionId}`);
  const feedbackEl = document.getElementById(`feedback-${questionId}`);
  const answer = input.value.trim();
  if (!answer) return;

  const { data, error } = await supabaseClient.rpc("submit_answer", {
    p_question_id: questionId,
    p_answer: answer,
  });

  if (error) return showToast(error.message, "error");

  feedbackEl.classList.remove("hidden", "ok", "bad");

  if (data.is_correct) {
    mySolvedQuestionIds.add(questionId);
    currentProfile.score = data.new_score;
    currentProfile.questions_solved = data.questions_solved;

    document.getElementById("student-my-score").textContent = data.new_score;
    document.getElementById("student-my-solved").textContent = data.questions_solved;
    document.getElementById("header-score-badge").textContent = `${data.new_score} pts`;
    document.getElementById(`q-card-${questionId}`).classList.add("solved");

    feedbackEl.classList.add("ok");
    if (data.points_awarded > 0) {
      feedbackEl.textContent = `🎉 Correct! +${data.points_awarded} points earned!`;
      showToast(`Correct! +${data.points_awarded} points!`, "success");
    } else {
      feedbackEl.textContent = `✅ Correct! (Points already awarded previously)`;
    }
    renderStudentTopicsGrid();
  } else {
    feedbackEl.classList.add("bad");
    feedbackEl.textContent = `❌ Not quite right — check your working and try again!`;
  }
};

// ============================================================================
// STUDENT CLASS DASHBOARD (TEACHER'S CLASS LEADERBOARD)
// ============================================================================
async function loadStudentClassDashboard() {
  if (!currentProfile.teacher_id) {
    document.getElementById("student-class-tbody").innerHTML =
      `<tr><td colspan="5" class="muted">No teacher assigned to this account.</td></tr>`;
    return;
  }

  const [{ data: classmates }, { data: teacher }] = await Promise.all([
    supabaseClient
      .from("profiles")
      .select("*")
      .eq("role", "student")
      .eq("teacher_id", currentProfile.teacher_id)
      .order("score", { ascending: false })
      .order("questions_solved", { ascending: false }),
    supabaseClient.from("profiles").select("full_name, school_name").eq("id", currentProfile.teacher_id).maybeSingle(),
  ]);

  const list = classmates || [];
  if (teacher) {
    document.getElementById("student-class-subtitle").textContent =
      `Teacher: ${teacher.full_name} • ${teacher.school_name || ""}`;
  }

  const myIndex = list.findIndex((s) => s.id === currentProfile.id);
  document.getElementById("student-class-rank-pill").textContent =
    myIndex >= 0 ? `Your Class Rank: #${myIndex + 1} of ${list.length}` : "Your Class Rank: #-";

  const tbody = document.getElementById("student-class-tbody");
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">No students in this class yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = list
    .map((s, idx) => {
      const isMe = s.id === currentProfile.id;
      return `
      <tr class="${isMe ? "highlight-me" : ""}">
        <td><strong>${formatRankMedal(idx + 1)}</strong></td>
        <td>${escapeHtml(s.full_name)} ${isMe ? `<span class="badge badge-student">You</span>` : ""}</td>
        <td>${escapeHtml(s.school_name || "—")}</td>
        <td>${s.questions_solved}</td>
        <td><strong>${s.score} pts</strong></td>
      </tr>`;
    })
    .join("");
}

// ============================================================================
// GLOBAL PLATFORM DASHBOARD (ALL STUDENTS RANKED BY SCORE)
// ============================================================================
async function loadGlobalDashboard() {
  const { data: students, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("role", "student")
    .order("score", { ascending: false })
    .order("questions_solved", { ascending: false });

  if (error) return showToast(error.message, "error");
  globalStudentsCache = (students || []).map((s, idx) => ({ ...s, rank: idx + 1 }));

  renderGlobalPodium();
  renderGlobalLeaderboard();
}

function renderGlobalPodium() {
  const podium = document.getElementById("global-podium");
  const top3 = globalStudentsCache.slice(0, 3);
  if (top3.length === 0) {
    podium.innerHTML = "";
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  podium.innerHTML = top3
    .map(
      (s, i) => `
      <div class="podium-card rank-${i + 1}">
        <div class="podium-medal">${medals[i]}</div>
        <h4>#${i + 1} ${escapeHtml(s.full_name)}</h4>
        <div class="muted">${escapeHtml(s.school_name || "Cambridge School")}</div>
        <div class="podium-score">${s.score} pts</div>
        <small class="muted">${s.questions_solved} solved</small>
      </div>`
    )
    .join("");
}

function renderGlobalLeaderboard() {
  const query = document.getElementById("global-search").value.trim().toLowerCase();
  const tbody = document.getElementById("global-leaderboard-tbody");

  const filtered = query
    ? globalStudentsCache.filter(
        (s) =>
          s.full_name.toLowerCase().includes(query) ||
          (s.school_name || "").toLowerCase().includes(query)
      )
    : globalStudentsCache;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">No students found on the platform yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((s) => {
      const isMe = currentProfile && s.id === currentProfile.id;
      return `
      <tr class="${isMe ? "highlight-me" : ""}">
        <td><strong>${formatRankMedal(s.rank)}</strong></td>
        <td>${escapeHtml(s.full_name)} ${isMe ? `<span class="badge badge-student">You</span>` : ""}</td>
        <td>${escapeHtml(s.school_name || "—")}</td>
        <td>${s.questions_solved}</td>
        <td><strong>${s.score} pts</strong></td>
      </tr>`;
    })
    .join("");
}

function formatRankMedal(rank) {
  if (rank === 1) return "🥇 #1";
  if (rank === 2) return "🥈 #2";
  if (rank === 3) return "🥉 #3";
  return `#${rank}`;
}

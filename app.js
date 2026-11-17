// ============================================================================
// Cambridge Math Arena — Frontend (v2 with multi-answer + delete student)
// ============================================================================

const DEFAULT_SUPABASE_URL = "https://yktszhisgtrzggorhzwo.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrdHN6aGlzZ3Ryemdnb3JoendvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ4MjYzOTAsImV4cCI6MjExMDQwMjM5MH0.jKaihUD8OoFyQe7hEF8VPytPQg6PfZx0ir6rNJqEwbE";
const STUDENT_EMAIL_DOMAIN = "student.cambridgemath.local";

let supabaseClient = null;
let studentSignupClient = null;
let currentUser = null;
let currentProfile = null;

let allTopics = [];
let allQuestions = [];
let mySolvedQuestionIds = new Set();
let pendingAnswerGroups = [];   // [{ type: 'required'|'alternative', values: [] }]
let activeTopicId = null;
let teacherStudentsCache = [];
let globalStudentsCache = [];

// ----------------------------------------------------------------------------
// Supabase bootstrap
// ----------------------------------------------------------------------------
function getSupabaseConfig() {
  const url = DEFAULT_SUPABASE_URL || localStorage.getItem("cm_supabase_url") || "";
  const key = DEFAULT_SUPABASE_ANON_KEY || localStorage.getItem("cm_supabase_key") || "";
  return { url: url.trim(), key: key.trim() };
}

function initSupabase() {
  const { url, key } = getSupabaseConfig();
  const banner = document.getElementById("config-banner");
  if (!url || !key) { banner.classList.remove("hidden"); return false; }
  banner.classList.add("hidden");
  const { createClient } = window.supabase;
  supabaseClient = createClient(url, key);
  studentSignupClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return true;
}

document.addEventListener("DOMContentLoaded", async () => {
  bindStaticEvents();
  if (initSupabase()) await checkSessionAndBoot();
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
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
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
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

function formatRankMedal(rank) {
  if (rank === 1) return "🥇 #1";
  if (rank === 2) return "🥈 #2";
  if (rank === 3) return "🥉 #3";
  return `#${rank}`;
}

// ----------------------------------------------------------------------------
// Auth
// ----------------------------------------------------------------------------
async function checkSessionAndBoot() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { showAuthView(); return; }
  currentUser = session.user;
  const { data: profile, error } = await supabaseClient
    .from("profiles").select("*").eq("id", currentUser.id).single();
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
  currentUser = null; currentProfile = null;
  document.getElementById("auth-section").classList.remove("hidden");
  document.getElementById("app-section").classList.add("hidden");
}

async function bootRoleWorkspace() {
  document.getElementById("auth-section").classList.add("hidden");
  document.getElementById("app-section").classList.remove("hidden");

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
  } else scorePill.classList.add("hidden");

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

  nav.innerHTML = tabs.map((t, i) =>
    `<button class="nav-btn ${i === 0 ? "active" : ""}" data-view="${t.id}">${t.label}</button>`
  ).join("");

  nav.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => switchWorkspaceView(btn.dataset.view));
  });

  await switchWorkspaceView(tabs[0].id);
}

async function switchWorkspaceView(viewId) {
  document.querySelectorAll(".nav-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.view === viewId));
  document.querySelectorAll(".view-panel").forEach(panel =>
    panel.classList.toggle("hidden", panel.id !== `view-${viewId}`));

  if (viewId === "owner-questions") await loadOwnerQuestionsView();
  if (viewId === "owner-teachers") await loadOwnerTeachersView();
  if (viewId === "teacher-class") await loadTeacherClassView();
  if (viewId === "student-practice") await loadStudentPracticeView();
  if (viewId === "class-dashboard") await loadStudentClassDashboard();
  if (viewId === "global-dashboard") await loadGlobalDashboard();
}

// ----------------------------------------------------------------------------
// Bind static events
// ----------------------------------------------------------------------------
function bindStaticEvents() {
  document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".auth-form").forEach(f => f.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`${tab.dataset.authTab}-form`).classList.add("active");
    });
  });

  const openConfig = () => {
    const { url, key } = getSupabaseConfig();
    document.getElementById("supabase-url-input").value = url;
    document.getElementById("supabase-key-input").value = key;
    document.getElementById("config-modal").classList.remove("hidden");
  };
  document.getElementById("open-config-btn").addEventListener("click", openConfig);
  document.getElementById("auth-config-trigger").addEventListener("click", openConfig);
  document.getElementById("close-config-modal").addEventListener("click", () =>
    document.getElementById("config-modal").classList.add("hidden"));

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

  document.getElementById("teacher-signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!supabaseClient) return showToast("Connect Supabase first.", "error");
    const fullName = document.getElementById("teacher-name").value.trim();
    const schoolName = document.getElementById("teacher-school").value.trim();
    const email = document.getElementById("teacher-email").value.trim();
    const password = document.getElementById("teacher-password").value;
    const { data, error } = await supabaseClient.auth.signUp({
      email, password,
      options: { data: { role: "teacher", full_name: fullName, school_name: schoolName } },
    });
    if (error) return showToast(error.message, "error");
    if (data.session) {
      showToast("Teacher account created! Trial active.", "success");
      await checkSessionAndBoot();
    } else {
      showToast("Account created! Check your email or disable confirmation in Supabase.", "info");
    }
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
    showToast("Signed out.", "info");
    showAuthView();
  });

  document.getElementById("q-image-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    const wrap = document.getElementById("q-image-preview-wrap");
    if (!file) return wrap.classList.add("hidden");
    document.getElementById("q-image-preview").src = URL.createObjectURL(file);
    wrap.classList.remove("hidden");
  });

  // Answer group builder
  document.getElementById("add-answer-group-btn").addEventListener("click", () => {
    const type = document.getElementById("new-group-type").value;
    const raw = document.getElementById("new-group-values").value.trim();
    if (!raw) return;
    const values = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (values.length === 0) return;
    if (type === "required" && values.length > 1) {
      showToast("Required answers are one value each. Add one per group.", "error");
      return;
    }
    pendingAnswerGroups.push({ type, values });
    document.getElementById("new-group-values").value = "";
    renderAnswerGroups();
  });
  document.getElementById("new-group-values").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); document.getElementById("add-answer-group-btn").click(); }
  });

  document.getElementById("add-topic-form").addEventListener("submit", handleOwnerCreateTopic);
  document.getElementById("add-question-form").addEventListener("submit", handleOwnerPublishQuestion);
  document.getElementById("owner-questions-filter-topic").addEventListener("change", renderOwnerQuestions);

  document.getElementById("create-student-form").addEventListener("submit", handleTeacherCreateStudent);
  document.getElementById("teacher-class-search").addEventListener("input", renderTeacherClassTable);

  document.getElementById("back-to-topics-btn").addEventListener("click", () => {
    activeTopicId = null;
    document.getElementById("student-topic-questions-area").classList.add("hidden");
    document.getElementById("student-topics-grid").classList.remove("hidden");
  });
  document.getElementById("student-q-filter").addEventListener("change", renderStudentTopicQuestions);

  document.getElementById("global-search").addEventListener("input", renderGlobalLeaderboard);

  document.getElementById("close-image-modal").addEventListener("click", () =>
    document.getElementById("image-modal").classList.add("hidden"));
  document.querySelector("#image-modal .modal-backdrop").addEventListener("click", () =>
    document.getElementById("image-modal").classList.add("hidden"));

  renderAnswerGroups();
}

function openImageZoom(url) {
  document.getElementById("modal-img").src = url;
  document.getElementById("image-modal").classList.remove("hidden");
}
window.openImageZoom = openImageZoom;

// ----------------------------------------------------------------------------
// Answer group builder UI
// ----------------------------------------------------------------------------
function renderAnswerGroups() {
  const c = document.getElementById("answer-groups-container");
  if (!c) return;
  if (pendingAnswerGroups.length === 0) {
    c.innerHTML = `<p class="muted" style="font-size:0.85rem;margin:0 0 4px;">No answer groups yet.</p>`;
    return;
  }
  c.innerHTML = pendingAnswerGroups.map((g, i) => {
    const badge = g.type === "required"
      ? `<span class="required-badge">REQUIRED</span>`
      : `<span class="alternative-badge">ANY OF</span>`;
    return `
      <div class="answer-group-item">
        ${badge}
        ${g.values.map(v => `<span class="answer-chip">${escapeHtml(v)}</span>`).join(" ")}
        <button type="button" class="btn btn-danger btn-sm"
          onclick="removeAnswerGroup(${i})" style="margin-left:auto;">×</button>
      </div>`;
  }).join("");
}
window.removeAnswerGroup = function (i) {
  pendingAnswerGroups.splice(i, 1);
  renderAnswerGroups();
};

// ----------------------------------------------------------------------------
// Owner: Questions
// ----------------------------------------------------------------------------
async function loadOwnerQuestionsView() {
  const [topicsRes, questionsRes, answersRes] = await Promise.all([
    supabaseClient.from("topics").select("*").order("name"),
    supabaseClient.from("questions").select("*").order("created_at", { ascending: false }),
    supabaseClient.from("question_answers").select("*"),
  ]);
  allTopics = topicsRes.data || [];
  const answerMap = new Map((answersRes.data || []).map(a => [a.question_id, a.answer_groups || []]));
  allQuestions = (questionsRes.data || []).map(q => ({
    ...q,
    answer_groups: answerMap.get(q.id) || [],
  }));

  const qTopicSelect = document.getElementById("q-topic");
  const filterSelect = document.getElementById("owner-questions-filter-topic");
  qTopicSelect.innerHTML = allTopics.map(t =>
    `<option value="${t.id}">${escapeHtml(t.icon)} ${escapeHtml(t.name)}</option>`).join("");
  filterSelect.innerHTML =
    `<option value="all">All Topics</option>` +
    allTopics.map(t => `<option value="${t.id}">${escapeHtml(t.icon)} ${escapeHtml(t.name)}</option>`).join("");

  document.getElementById("owner-topics-list").innerHTML = allTopics.map(t => `
    <div class="topic-mini-item">
      <div>
        <strong>${escapeHtml(t.icon)} ${escapeHtml(t.name)}</strong>
        <div class="muted">${escapeHtml(t.stage_group)}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteTopic('${t.id}')">Delete</button>
    </div>`).join("");

  renderOwnerQuestions();
}

async function handleOwnerCreateTopic(e) {
  e.preventDefault();
  const name = document.getElementById("topic-name").value.trim();
  const icon = document.getElementById("topic-icon").value.trim() || "📐";
  const stage_group = document.getElementById("topic-stage").value.trim();
  const description = document.getElementById("topic-desc").value.trim();
  const { error } = await supabaseClient.from("topics").insert({ name, icon, stage_group, description });
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
  if (pendingAnswerGroups.length === 0)
    return showToast("Add at least one answer group.", "error");
  const file = document.getElementById("q-image-file").files[0];
  if (!file) return showToast("Choose a question image.", "error");

  const btn = document.getElementById("publish-question-btn");
  btn.disabled = true; btn.textContent = "Uploading Image...";

  try {
    const ext = file.name.split(".").pop() || "png";
    const filePath = `questions/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error: upErr } = await supabaseClient.storage
      .from("question-images").upload(filePath, file, { cacheControl: "3600", upsert: false });
    if (upErr) throw upErr;
    const { data: urlData } = supabaseClient.storage.from("question-images").getPublicUrl(filePath);

    const { error: rpcError } = await supabaseClient.rpc("owner_create_question", {
      p_topic_id: document.getElementById("q-topic").value,
      p_title: document.getElementById("q-title").value.trim(),
      p_stage: document.getElementById("q-stage").value,
      p_image_url: urlData.publicUrl,
      p_points: Number(document.getElementById("q-points").value) || 10,
      p_answer_groups: pendingAnswerGroups,
      p_require_multi: document.getElementById("q-require-multi").checked,
    });
    if (rpcError) throw rpcError;

    showToast("Question published!", "success");
    e.target.reset();
    pendingAnswerGroups = [];
    renderAnswerGroups();
    document.getElementById("q-image-preview-wrap").classList.add("hidden");
    await loadOwnerQuestionsView();
  } catch (err) {
    showToast(err.message || "Failed to publish question.", "error");
  } finally {
    btn.disabled = false; btn.textContent = "Publish Question";
  }
}

function renderOwnerQuestions() {
  const filterId = document.getElementById("owner-questions-filter-topic").value;
  const topicMap = new Map(allTopics.map(t => [t.id, t]));
  const filtered = filterId === "all" ? allQuestions : allQuestions.filter(q => q.topic_id === filterId);
  const container = document.getElementById("owner-questions-list");
  if (filtered.length === 0) {
    container.innerHTML = `<p class="muted">No questions yet.</p>`;
    return;
  }
  container.innerHTML = filtered.map(q => {
    const topic = topicMap.get(q.topic_id);
    const groupsHtml = (q.answer_groups || []).map(g => `
      <div class="group-preview-row">
        ${g.type === "required"
          ? `<span class="required-badge">REQ</span>`
          : `<span class="alternative-badge">ANY</span>`}
        ${(g.values || []).map(v => `<span class="answer-chip">${escapeHtml(v)}</span>`).join(" ")}
      </div>`).join("");
    return `
      <div class="question-card">
        <div class="question-img-box" onclick="openImageZoom('${escapeHtml(q.image_url)}')">
          <img src="${escapeHtml(q.image_url)}" alt="${escapeHtml(q.title)}" />
        </div>
        <div class="question-body">
          <div class="question-meta">
            <span class="stage-tag">${escapeHtml(q.stage)}</span>
            <span class="points-tag">${q.points} pts</span>
            ${q.require_multi_answers ? `<span class="stage-tag">Multi</span>` : ""}
          </div>
          <strong>${escapeHtml(q.title)}</strong>
          <small class="muted">${topic ? `${escapeHtml(topic.icon)} ${escapeHtml(topic.name)}` : ""}</small>
          <div class="group-preview">${groupsHtml}</div>
          <button class="btn btn-danger btn-sm mt-lg" onclick="deleteQuestion('${q.id}')">Delete Question</button>
        </div>
      </div>`;
  }).join("");
}

window.deleteQuestion = async function (questionId) {
  if (!confirm("Delete this question?")) return;
  const { error } = await supabaseClient.from("questions").delete().eq("id", questionId);
  if (error) return showToast(error.message, "error");
  showToast("Question deleted.", "info");
  await loadOwnerQuestionsView();
};

// ----------------------------------------------------------------------------
// Owner: Teachers & Waivers
// ----------------------------------------------------------------------------
async function loadOwnerTeachersView() {
  const { data: profiles, error } = await supabaseClient
    .from("profiles").select("*").in("role", ["teacher", "student"])
    .order("created_at", { ascending: false });
  if (error) return showToast(error.message, "error");
  const teachers = (profiles || []).filter(p => p.role === "teacher");
  const students = (profiles || []).filter(p => p.role === "student");
  const counts = {};
  students.forEach(s => { counts[s.teacher_id] = (counts[s.teacher_id] || 0) + 1; });

  document.getElementById("owner-stat-teachers").textContent = teachers.length;
  document.getElementById("owner-stat-waived").textContent = teachers.filter(t => t.subscription_waived).length;
  document.getElementById("owner-stat-students").textContent = students.length;

  const tbody = document.getElementById("owner-teachers-tbody");
  if (teachers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No teachers yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = teachers.map(t => {
    const days = daysLeftInTrial(t.trial_ends_at);
    let badge = t.subscription_waived
      ? `<span class="badge badge-success">Fee Waived</span>`
      : days > 0
        ? `<span class="badge badge-warning">Trial (${days}d left)</span>`
        : `<span class="badge badge-danger">Trial Expired</span>`;
    const trialDate = t.trial_ends_at ? new Date(t.trial_ends_at).toLocaleDateString() : "—";
    return `
      <tr>
        <td><strong>${escapeHtml(t.full_name)}</strong><br/><small class="muted">${escapeHtml(t.email || "")}</small></td>
        <td>${escapeHtml(t.school_name || "—")}</td>
        <td>${counts[t.id] || 0}</td>
        <td>${trialDate}</td>
        <td>${badge}</td>
        <td>
          <button class="btn btn-sm ${t.subscription_waived ? "btn-outline" : "btn-amber"}"
            onclick="toggleWaiveSubscription('${t.id}', ${!t.subscription_waived})">
            ${t.subscription_waived ? "Revoke Waiver" : "Waive Fee"}
          </button>
        </td>
      </tr>`;
  }).join("");
}

window.toggleWaiveSubscription = async function (teacherId, waive) {
  const { error } = await supabaseClient.from("profiles")
    .update({ subscription_waived: waive }).eq("id", teacherId);
  if (error) return showToast(error.message, "error");
  showToast(waive ? "Fee waived!" : "Waiver removed.", "success");
  await loadOwnerTeachersView();
};

// ----------------------------------------------------------------------------
// Teacher: Class & Students
// ----------------------------------------------------------------------------
async function loadTeacherClassView() {
  const { data: fresh } = await supabaseClient.from("profiles")
    .select("*").eq("id", currentProfile.id).single();
  if (fresh) currentProfile = fresh;

  const schoolInput = document.getElementById("new-student-school");
  if (!schoolInput.value) schoolInput.value = currentProfile.school_name || "";

  const banner = document.getElementById("teacher-trial-banner");
  const active = isTeacherSubscriptionActive(currentProfile);
  const days = daysLeftInTrial(currentProfile.trial_ends_at);
  if (currentProfile.subscription_waived) {
    banner.className = "trial-banner trial-waived";
    banner.innerHTML = `<span>✅ Subscription Fee Waived — Full Lifetime Access</span>`;
  } else if (active) {
    banner.className = "trial-banner trial-active";
    banner.innerHTML = `<span>🎁 Trial Active: <strong>${days} day(s)</strong> left</span>`;
  } else {
    banner.className = "trial-banner trial-expired";
    banner.innerHTML = `<span>⚠️ Trial expired. Ask Owner to waive your fee.</span>`;
  }
  document.getElementById("create-student-btn").disabled = !active;

  const { data: students, error } = await supabaseClient
    .from("profiles").select("*").eq("role", "student")
    .eq("teacher_id", currentProfile.id)
    .order("score", { ascending: false })
    .order("questions_solved", { ascending: false });
  if (error) return showToast(error.message, "error");

  teacherStudentsCache = students || [];
  const count = teacherStudentsCache.length;
  const total = teacherStudentsCache.reduce((a, s) => a + (s.score || 0), 0);
  const top = count > 0 ? teacherStudentsCache[0].score : 0;
  document.getElementById("teacher-stat-count").textContent = count;
  document.getElementById("teacher-stat-avg").textContent = count ? Math.round(total / count) : 0;
  document.getElementById("teacher-stat-top").textContent = top;

  renderTeacherClassTable();
}

function renderTeacherClassTable() {
  const q = document.getElementById("teacher-class-search").value.trim().toLowerCase();
  const tbody = document.getElementById("teacher-class-tbody");
  const ranked = teacherStudentsCache.map((s, i) => ({ ...s, rank: i + 1 }));
  const filtered = q
    ? ranked.filter(s =>
        s.full_name.toLowerCase().includes(q) ||
        (s.username || "").toLowerCase().includes(q) ||
        (s.school_name || "").toLowerCase().includes(q))
    : ranked;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">No students found.</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(s => `
    <tr>
      <td><strong>${formatRankMedal(s.rank)}</strong></td>
      <td>${escapeHtml(s.full_name)}</td>
      <td><code>${escapeHtml(s.username || "")}</code></td>
      <td>${escapeHtml(s.school_name || "—")}</td>
      <td>${s.questions_solved}</td>
      <td><strong>${s.score} pts</strong></td>
      <td class="table-actions">
        <button class="btn btn-danger btn-sm"
          onclick="deleteStudent('${s.id}', '${escapeHtml(s.full_name).replace(/'/g, "\\'")}')">
          Delete
        </button>
      </td>
    </tr>`).join("");
}

window.deleteStudent = async function (studentId, name) {
  if (!confirm(`Delete student "${name}"? This cannot be undone.`)) return;
  const { error } = await supabaseClient.rpc("teacher_delete_student", { p_student_id: studentId });
  if (error) return showToast(error.message, "error");
  showToast(`Student "${name}" deleted.`, "success");
  await loadTeacherClassView();
};

async function handleTeacherCreateStudent(e) {
  e.preventDefault();
  if (!isTeacherSubscriptionActive(currentProfile))
    return showToast("Trial expired. Ask Owner to waive your fee.", "error");

  const fullName = document.getElementById("new-student-name").value.trim();
  const rawUsername = document.getElementById("new-student-username").value;
  const password = document.getElementById("new-student-password").value;
  const schoolName = document.getElementById("new-student-school").value.trim();
  const { clean, email } = usernameToEmail(rawUsername);
  if (clean.length < 3)
    return showToast("Username must be 3+ chars.", "error");

  const btn = document.getElementById("create-student-btn");
  btn.disabled = true; btn.textContent = "Creating Account...";
  try {
    const { data: existing } = await supabaseClient
      .from("profiles").select("id").eq("username", clean).maybeSingle();
    if (existing) throw new Error(`Username "${clean}" already taken.`);

    const { error } = await studentSignupClient.auth.signUp({
      email, password,
      options: {
        data: {
          role: "student", full_name: fullName,
          username: clean, school_name: schoolName,
          teacher_id: currentProfile.id,
        },
      },
    });
    if (error) throw error;

    showToast(`Student "${fullName}" created! Username: ${clean}`, "success");
    e.target.reset();
    document.getElementById("new-student-school").value = currentProfile.school_name || "";
    await loadTeacherClassView();
  } catch (err) {
    showToast(err.message || "Could not create student.", "error");
  } finally {
    btn.disabled = false; btn.textContent = "Create Student Account";
  }
}

// ----------------------------------------------------------------------------
// Student: Practice
// ----------------------------------------------------------------------------
async function loadStudentPracticeView() {
  const [topicsRes, questionsRes, attemptsRes, profileRes] = await Promise.all([
    supabaseClient.from("topics").select("*").order("name"),
    supabaseClient.from("questions").select("*").order("created_at", { ascending: true }),
    supabaseClient.from("student_attempts")
      .select("question_id, is_correct")
      .eq("student_id", currentProfile.id)
      .eq("is_correct", true),
    supabaseClient.from("profiles").select("score, questions_solved")
      .eq("id", currentProfile.id).single(),
  ]);
  if (profileRes.data) {
    currentProfile.score = profileRes.data.score;
    currentProfile.questions_solved = profileRes.data.questions_solved;
  }
  document.getElementById("student-my-score").textContent = currentProfile.score;
  document.getElementById("student-my-solved").textContent = currentProfile.questions_solved;
  document.getElementById("header-score-badge").textContent = `${currentProfile.score} pts`;

  allTopics = topicsRes.data || [];
  allQuestions = questionsRes.data || [];
  mySolvedQuestionIds = new Set((attemptsRes.data || []).map(a => a.question_id));

  renderStudentTopicsGrid();
  if (activeTopicId) renderStudentTopicQuestions();
}

function renderStudentTopicsGrid() {
  const grid = document.getElementById("student-topics-grid");
  if (allTopics.length === 0) {
    grid.innerHTML = `<p class="muted">No topics yet.</p>`;
    return;
  }
  grid.innerHTML = allTopics.map(topic => {
    const tq = allQuestions.filter(q => q.topic_id === topic.id);
    const solved = tq.filter(q => mySolvedQuestionIds.has(q.id)).length;
    return `
      <div class="topic-card" onclick="openStudentTopic('${topic.id}')">
        <div class="topic-icon">${escapeHtml(topic.icon)}</div>
        <h3>${escapeHtml(topic.name)}</h3>
        <p>${escapeHtml(topic.description || topic.stage_group)}</p>
        <div class="topic-progress">
          <span>${tq.length} Question(s)</span>
          <span>✅ ${solved} Solved</span>
        </div>
      </div>`;
  }).join("");
}

window.openStudentTopic = function (topicId) {
  activeTopicId = topicId;
  const topic = allTopics.find(t => t.id === topicId);
  document.getElementById("active-topic-heading").textContent =
    topic ? `${topic.icon} ${topic.name}` : "Questions";
  document.getElementById("student-topics-grid").classList.add("hidden");
  document.getElementById("student-topic-questions-area").classList.remove("hidden");
  renderStudentTopicQuestions();
};

function renderStudentTopicQuestions() {
  const filter = document.getElementById("student-q-filter").value;
  let qs = allQuestions.filter(q => q.topic_id === activeTopicId);
  if (filter === "solved") qs = qs.filter(q => mySolvedQuestionIds.has(q.id));
  if (filter === "unsolved") qs = qs.filter(q => !mySolvedQuestionIds.has(q.id));
  const c = document.getElementById("student-questions-list");
  if (qs.length === 0) { c.innerHTML = `<p class="muted">No questions match this filter.</p>`; return; }

  c.innerHTML = qs.map(q => {
    const isSolved = mySolvedQuestionIds.has(q.id);
    const multi = q.require_multi_answers;
    const placeholder = multi
      ? "e.g. 3, 4  (separate with commas)"
      : "Enter your answer...";
    return `
      <div class="question-card ${isSolved ? "solved" : ""}" id="q-card-${q.id}">
        <div class="question-img-box" onclick="openImageZoom('${escapeHtml(q.image_url)}')">
          <img src="${escapeHtml(q.image_url)}" alt="${escapeHtml(q.title)}" />
        </div>
        <div class="question-body">
          <div class="question-meta">
            <span class="stage-tag">${escapeHtml(q.stage)}</span>
            <span class="points-tag">${isSolved ? "✅ Solved" : `+${q.points} pts`}</span>
            ${multi ? `<span class="stage-tag">Multi-answer</span>` : ""}
          </div>
          <strong>${escapeHtml(q.title)}</strong>
          <form class="student-answer-row" onsubmit="handleStudentSubmitAnswer(event, '${q.id}')">
            <input type="text" id="ans-input-${q.id}" placeholder="${placeholder}" required />
            <button type="submit" class="btn btn-primary btn-sm">Check</button>
          </form>
          ${multi ? `<small class="muted">⚠️ Multiple answers needed — separate with commas.</small>` : ""}
          <div id="feedback-${q.id}" class="attempt-feedback hidden"></div>
        </div>
      </div>`;
  }).join("");
}

window.handleStudentSubmitAnswer = async function (e, questionId) {
  e.preventDefault();
  const input = document.getElementById(`ans-input-${questionId}`);
  const feedback = document.getElementById(`feedback-${questionId}`);
  const raw = input.value.trim();
  if (!raw) return;

  const q = allQuestions.find(x => x.id === questionId);
  const answers = q && q.require_multi_answers
    ? raw.split(",").map(s => s.trim()).filter(Boolean)
    : [raw];
  const payload = JSON.stringify(answers);

  const { data, error } = await supabaseClient.rpc("submit_answer", {
    p_question_id: questionId,
    p_answer: payload,
  });
  if (error) return showToast(error.message, "error");

  feedback.classList.remove("hidden", "ok", "bad");
  if (data.is_correct) {
    mySolvedQuestionIds.add(questionId);
    currentProfile.score = data.new_score;
    currentProfile.questions_solved = data.questions_solved;
    document.getElementById("student-my-score").textContent = data.new_score;
    document.getElementById("student-my-solved").textContent = data.questions_solved;
    document.getElementById("header-score-badge").textContent = `${data.new_score} pts`;
    document.getElementById(`q-card-${questionId}`).classList.add("solved");
    feedback.classList.add("ok");
    feedback.textContent = data.points_awarded > 0
      ? `🎉 Correct! +${data.points_awarded} points!`
      : `✅ Correct! (Already awarded)`;
    if (data.points_awarded > 0) showToast(`+${data.points_awarded} points!`, "success");
    renderStudentTopicsGrid();
  } else {
    feedback.classList.add("bad");
    feedback.textContent = `❌ Not quite right — try again!`;
  }
};

// ----------------------------------------------------------------------------
// Student: Class Dashboard
// ----------------------------------------------------------------------------
async function loadStudentClassDashboard() {
  if (!currentProfile.teacher_id) {
    document.getElementById("student-class-tbody").innerHTML =
      `<tr><td colspan="5" class="muted">No teacher assigned.</td></tr>`;
    return;
  }
  const [classmatesRes, teacherRes] = await Promise.all([
    supabaseClient.from("profiles").select("*").eq("role", "student")
      .eq("teacher_id", currentProfile.teacher_id)
      .order("score", { ascending: false })
      .order("questions_solved", { ascending: false }),
    supabaseClient.from("profiles").select("full_name, school_name")
      .eq("id", currentProfile.teacher_id).maybeSingle(),
  ]);
  const list = classmatesRes.data || [];
  if (teacherRes.data) {
    document.getElementById("student-class-subtitle").textContent =
      `Teacher: ${teacherRes.data.full_name} • ${teacherRes.data.school_name || ""}`;
  }
  const idx = list.findIndex(s => s.id === currentProfile.id);
  document.getElementById("student-class-rank-pill").textContent =
    idx >= 0 ? `Your Class Rank: #${idx + 1} of ${list.length}` : "Your Class Rank: #-";

  const tbody = document.getElementById("student-class-tbody");
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">No classmates yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((s, i) => {
    const me = s.id === currentProfile.id;
    return `
      <tr class="${me ? "highlight-me" : ""}">
        <td><strong>${formatRankMedal(i + 1)}</strong></td>
        <td>${escapeHtml(s.full_name)} ${me ? `<span class="badge badge-student">You</span>` : ""}</td>
        <td>${escapeHtml(s.school_name || "—")}</td>
        <td>${s.questions_solved}</td>
        <td><strong>${s.score} pts</strong></td>
      </tr>`;
  }).join("");
}

// ----------------------------------------------------------------------------
// Global Dashboard
// ----------------------------------------------------------------------------
async function loadGlobalDashboard() {
  const { data: students, error } = await supabaseClient
    .from("profiles").select("*").eq("role", "student")
    .order("score", { ascending: false })
    .order("questions_solved", { ascending: false });
  if (error) return showToast(error.message, "error");
  globalStudentsCache = (students || []).map((s, i) => ({ ...s, rank: i + 1 }));
  renderGlobalPodium();
  renderGlobalLeaderboard();
}

function renderGlobalPodium() {
  const podium = document.getElementById("global-podium");
  const top3 = globalStudentsCache.slice(0, 3);
  if (top3.length === 0) { podium.innerHTML = ""; return; }
  const medals = ["🥇", "🥈", "🥉"];
  podium.innerHTML = top3.map((s, i) => `
    <div class="podium-card rank-${i + 1}">
      <div class="podium-medal">${medals[i]}</div>
      <h4>#${i + 1} ${escapeHtml(s.full_name)}</h4>
      <div class="muted">${escapeHtml(s.school_name || "Cambridge School")}</div>
      <div class="podium-score">${s.score} pts</div>
      <small class="muted">${s.questions_solved} solved</small>
    </div>`).join("");
}

function renderGlobalLeaderboard() {
  const q = document.getElementById("global-search").value.trim().toLowerCase();
  const tbody = document.getElementById("global-leaderboard-tbody");
  const filtered = q
    ? globalStudentsCache.filter(s =>
        s.full_name.toLowerCase().includes(q) ||
        (s.school_name || "").toLowerCase().includes(q))
    : globalStudentsCache;
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">No students yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(s => {
    const me = currentProfile && s.id === currentProfile.id;
    return `
      <tr class="${me ? "highlight-me" : ""}">
        <td><strong>${formatRankMedal(s.rank)}</strong></td>
        <td>${escapeHtml(s.full_name)} ${me ? `<span class="badge badge-student">You</span>` : ""}</td>
        <td>${escapeHtml(s.school_name || "—")}</td>
        <td>${s.questions_solved}</td>
        <td><strong>${s.score} pts</strong></td>
      </tr>`;
  }).join("");
}

// ==================== 1. Supabase 連線初始化 ====================
const supabaseUrl = 'https://rkrpukbauzzyljvwtjfy.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcnB1a2JhdXp6eWxqdnd0amZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyNTA1OTYsImV4cCI6MjEwMTgyNjU5Nn0.qLlMFm2Xz3MFZ7EWSwzM79zTwA06Up_TX8o-rkaX99Q';

// 避免與 CDN 導入的全域變數 supabase 命名衝突，我們宣告為 supabaseClient
let supabaseClient = null;
try {
  const lib = window.supabase || (typeof supabase !== 'undefined' ? supabase : null);
  if (lib && lib.createClient) {
    supabaseClient = lib.createClient(supabaseUrl, supabaseKey);
  } else {
    console.error('Supabase SDK 未能正確載入。');
  }
} catch (err) {
  console.error('Supabase 初始化失敗:', err);
}

// 密碼重設狀態全域監控與防堵機制 (在腳本加載最開頭進行攔截，防止 SDK 自動清空 URL 導致驗證標記丟失)
let isRecoveringPassword = false;
const isThisTabCallback = typeof window !== 'undefined' && (
  window.location.search.includes('code=') || 
  window.location.hash.includes('type=recovery') || 
  window.location.hash.includes('access_token=')
);

if (supabaseClient) {
  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      if (isThisTabCallback) {
        isRecoveringPassword = true;
        const modal = document.getElementById('modal-reset-password');
        if (modal) {
          modal.classList.add('active');
          // 確保 toast 函數可用才呼叫
          if (typeof showToast === 'function') {
            showToast('驗證成功，請設定您的新密碼。', 'info');
          }
        }
      }
    }
  });
}

// 本地 Session Key
const SESSION_KEY = 'rd_sync_session';

// 預設測試帳號結構 (用於首次登入自動註冊對照組)
const DEFAULT_USERS = [
  { email: 'manager@company.com', name: '專案主管 Leo', role: 'manager' },
  { email: 'rd1@company.com', name: '資深工程師 Ken', role: 'rd' },
  { email: 'rd2@company.com', name: '全端工程師 Alice', role: 'rd' },
  { email: 'rd3@company.com', name: '前端工程師 Bob', role: 'rd' }
];

// 取得目前的年份與週數資訊 (動態產生前後數週)
function getWeeksList() {
  const weeks = [];
  const curr = new Date();
  for (let i = -2; i <= 3; i++) {
    const d = new Date(curr.getTime() + i * 7 * 24 * 60 * 60 * 1000);
    const year = d.getFullYear();
    const oneJan = new Date(year, 0, 1);
    const numberOfDays = Math.floor((d - oneJan) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((numberOfDays + oneJan.getDay() + 1) / 7);
    const weekStr = `${year}-W${String(weekNumber).padStart(2, '0')}`;
    
    const dayOfWeek = d.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(d.getTime() + mondayOffset * 24 * 60 * 60 * 1000);
    const friday = new Date(monday.getTime() + 4 * 24 * 60 * 60 * 1000);
    
    const label = `${weekStr} (${monday.getMonth() + 1}/${monday.getDate()} - ${friday.getMonth() + 1}/${friday.getDate()})`;
    weeks.push({ 
      value: weekStr, 
      label: label, 
      isCurrent: i === 0,
      monday: monday.toISOString()
    });
  }
  return weeks;
}

// 雲端資料庫首次載入自動 Seeding (當 database 中沒有 projects 時執行)
async function ensureDefaultUsersAndProjects() {
  if (!supabaseClient) return;
  try {
    // 1. 檢查 profiles 是否為空，若為空或只有 1 人，在背景預先註冊 RDs
    const { data: profiles } = await supabaseClient.from('profiles').select('*');
    
    if (profiles && profiles.length <= 1) {
      showToast('正在初始化雲端測試資料庫，請稍候...', 'info');
      
      const defaultRDs = [
        { email: 'rd1@company.com', name: '資深工程師 Ken', role: 'rd' },
        { email: 'rd2@company.com', name: '全端工程師 Alice', role: 'rd' },
        { email: 'rd3@company.com', name: '前端工程師 Bob', role: 'rd' }
      ];

      for (const rd of defaultRDs) {
        if (!profiles.some(p => p.email.toLowerCase() === rd.email.toLowerCase())) {
          // 註冊 auth 使用者 (預設密碼都是 password)
          const signupRes = await supabaseClient.auth.signUp({ email: rd.email, password: 'password' });
          if (!signupRes.error && signupRes.data.user) {
            // 寫入 profile 設定檔
            await supabaseClient.from('profiles').insert({
              id: signupRes.data.user.id,
              name: rd.name,
              email: rd.email,
              role: rd.role
            });
          }
        }
      }
    }

    // 重新撈取所有成員清單 (取得真實 UUID 關聯)
    const { data: allProfiles } = await supabaseClient.from('profiles').select('*');
    const ken = allProfiles.find(p => p.email.includes('rd1'));
    const alice = allProfiles.find(p => p.email.includes('rd2'));
    const bob = allProfiles.find(p => p.email.includes('rd3'));
    const manager = allProfiles.find(p => p.email.includes('manager'));

    // 2. 檢查專案是否為空，若為空則寫入初始專案與任務
    const { data: projects } = await supabaseClient.from('projects').select('*');
    if (projects && projects.length === 0 && manager && ken && alice && bob) {
      // 寫入專案 1
      const p1Res = await supabaseClient.from('projects').insert({
        name: 'AI 智慧對話核心系統',
        description: '開發企業級智能對話 API 串接模組與後端大語言模型微調架構。',
        manager_id: manager.id
      }).select();

      // 寫入專案 2
      const p2Res = await supabaseClient.from('projects').insert({
        name: 'E-commerce 購物平台改版',
        description: '購物車流程、結帳安全性與後台儀表板效能與 UI/UX 升級優化。',
        manager_id: manager.id
      }).select();

      if (p1Res.data && p2Res.data) {
        const p1Id = p1Res.data[0].id;
        const p2Id = p2Res.data[0].id;

        // 寫入專案成員
        await supabaseClient.from('project_members').insert([
          { project_id: p1Id, user_id: ken.id },
          { project_id: p1Id, user_id: alice.id },
          { project_id: p2Id, user_id: alice.id },
          { project_id: p2Id, user_id: bob.id }
        ]);

        // 寫入任務
        const t1Res = await supabaseClient.from('tasks').insert([
          {
            project_id: p1Id,
            title: '修復並重構 API 在並行請求下的連線逾時問題',
            description: '當多個使用者同時發送詢問時，連線池滿載導致伺服器崩潰。需要重構 Connection Pool 邏輯。',
            type: 'bug',
            priority: 'high',
            status: 'inprogress',
            assignee_id: ken.id,
            bug_steps: '1. 開啟並行壓力測試腳本(100 QPS)\n2. 持續 5 秒後，伺服器丟出 ConnectionTimeoutException。',
            bug_env: 'Staging Server (Linux Ubuntu 22.04)',
            bug_severity: 'critical'
          },
          {
            project_id: p1Id,
            title: '驗證 OAuth2 第三方登入安全機制與驗證邏輯',
            description: '設計測試案例以驗證 JWT token 過期、無效 token 以及重新整理 token 的邏輯安全。',
            type: 'test',
            priority: 'medium',
            status: 'todo',
            assignee_id: alice.id,
            test_cases: '- 測試過期 Token 應回傳 401\n- 測試非法 Signature Token 應回傳 403\n- 測試 Refresh Token 正常簽發新 Access Token',
            test_platform: 'Web, Android, iOS'
          },
          {
            project_id: p1Id,
            title: '撰寫 API 規格文件與部署 Docker 腳本',
            description: '將對話模組封裝為 Docker 容器，並在 Swagger 中寫好完整的 API 開發說明文件。',
            type: 'task',
            priority: 'low',
            status: 'done',
            assignee_id: ken.id
          },
          {
            project_id: p2Id,
            title: '購物網頁購物車 RWD 跑版 Bug',
            description: '在行動端等小螢幕尺寸下，購物車側邊欄會被內容蓋住，無法點擊「去結帳」按鈕。',
            type: 'bug',
            priority: 'high',
            status: 'inprogress',
            assignee_id: bob.id,
            bug_steps: '1. 在 Safari 行動模擬器打開購物車頁面\n2. 點擊右上角購物車圖示\n3. 發現滑出選單底部按鈕跑版。',
            bug_env: 'Mobile Safari / iOS 16',
            bug_severity: 'major'
          }
        ]).select();

        // 寫入預設行程 (Ken & Alice)
        const currentWeekVal = getWeeksList().find(w => w.isCurrent).value;
        await supabaseClient.from('schedules').insert([
          {
            user_id: ken.id,
            week_id: currentWeekVal,
            days: {
              monday:    [0, 1, 1, 0, 0, 2, 2, 0, 0, 0],
              tuesday:   [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
              wednesday: [0, 0, 0, 0, 0, 2, 2, 1, 1, 0],
              thursday:  [1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
              friday:    [0, 0, 0, 0, 0, 2, 2, 2, 0, 0]
            }
          },
          {
            user_id: alice.id,
            week_id: currentWeekVal,
            days: {
              monday:    [0, 1, 1, 0, 0, 2, 2, 0, 0, 0],
              tuesday:   [0, 0, 0, 1, 1, 0, 0, 0, 0, 0],
              wednesday: [0, 0, 0, 0, 0, 2, 2, 0, 0, 0],
              thursday:  [1, 1, 0, 0, 0, 2, 2, 0, 0, 0],
              friday:    [0, 0, 0, 0, 0, 0, 0, 2, 2, 0]
            }
          }
        ]);

        // 寫入預設週報 (Ken)
        await supabaseClient.from('reports').insert([
          {
            user_id: ken.id,
            week_id: currentWeekVal,
            progress_text: '1. 完成了 API 的基礎 Docker 化部署與測試\n2. 撰寫完 Swagger 連接說明文件並發布。',
            problems_text: '【⚠️ 重大阻礙】Staging 資料庫伺服器偶爾會出現斷線，導致高流量測試無法順利完成，需要管理員聯絡 DevOps 團隊重啟。',
            custom_text: '希望下週能有機會和 DevOps 進行 15 分鐘的連線設定校對。',
            timestamp: '2026-08-09 14:00'
          }
        ]);

        // 寫入預設留言
        const tsk1 = t1Res.data ? t1Res.data[0] : null;
        if (tsk1) {
          await supabaseClient.from('task_comments').insert([
            { task_id: tsk1.id, sender_name: '專案主管 Leo', text: 'Ken，這個問題會影響下週的展示，請務必本週解決。', created_at: new Date(Date.now() - 3600000).toISOString() },
            { task_id: tsk1.id, sender_name: '資深工程師 Ken', text: '收到，目前正在重構數據庫池連結，預計今天下午會完成。', created_at: new Date().toISOString() }
          ]);
        }

        // 寫入預設活動日誌
        await supabaseClient.from('activities').insert([
          { text: '系統雲端資料庫初始化成功。', timestamp: '2026-08-09 09:00' },
          { text: '資深工程師 Ken 更新了本週的開會行程。', timestamp: '2026-08-09 11:45' },
          { text: '資深工程師 Ken 提交了本週進度報告 (含有 Blocker)。', timestamp: '2026-08-09 14:02' }
        ]);
        
        showToast('雲端初始化完畢！資料已同步。', 'success');
      }
    }
  } catch (err) {
    console.error('資料庫 seeding 出錯:', err);
  }
}

// ==================== 2. 全域狀態變數 ====================
let currentUser = null;
let currentProject = null;
let currentTaskDetail = null;
let currentWeeks = [];
let selectedWeekId = '';

const HOUR_SLOTS = [
  '08:00-09:00',
  '09:00-10:00',
  '10:00-11:00',
  '11:00-12:00',
  '12:00-13:00',
  '13:00-14:00',
  '14:00-15:00',
  '15:00-16:00',
  '16:00-17:00',
  '17:00-18:00'
];

const WEEKDAYS = {
  monday: '星期一',
  tuesday: '星期二',
  wednesday: '星期三',
  thursday: '星期四',
  friday: '星期五'
};

// ==================== 3. 系統核心生命週期與啟動 ====================
document.addEventListener('DOMContentLoaded', async () => {
  currentWeeks = getWeeksList();
  selectedWeekId = currentWeeks.find(w => w.isCurrent).value;

  if (!supabaseClient) {
    showToast('雲端資料庫連線失敗，請確認 Supabase 設定或網路連線。', 'danger');
    navigateTo('auth-view');
    return;
  }

  // 檢查 Supabase 雲端登入狀態
  const { data: { session } } = await supabaseClient.auth.getSession();

  // 若存在有效會話，且本頁面並非密碼重設的回呼頁面、亦無重設狀態，才進行自動登入
  if (session && !isRecoveringPassword && !isThisTabCallback) {
    // 抓取雲端個人設定檔
    const { data: profile, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single();

    if (profile) {
      currentUser = profile;
      showUserSession();
    } else {
      // 若 Session 存在但 Profile 遺失，強制登出並轉導
      await supabaseClient.auth.signOut();
      navigateTo('auth-view');
    }
  } else {
    navigateTo('auth-view');
    // 如果全域已經攔截到密碼重設狀態，立即將視窗顯現出來
    if (isRecoveringPassword) {
      const modal = document.getElementById('modal-reset-password');
      if (modal) {
        modal.classList.add('active');
        showToast('驗證成功，請設定您的新密碼。', 'info');
      }
    }
  }

  // 綁定檔案備份拖曳或改變事件
  const importInput = document.getElementById('import-file-input');
  if (importInput) {
    importInput.addEventListener('change', () => {
      showToast('已選擇備份檔案，請點擊「匯入資料還原」開始還原。', 'info');
    });
  }

  // 綁定進度更新輸入框自動高度延伸
  const progressTextarea = document.getElementById('progress-update-text');
  if (progressTextarea) {
    progressTextarea.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = this.scrollHeight + 'px';
    });
  }

  // 綁定任務留言輸入框自動高度延伸
  const commentInput = document.getElementById('comment-new-input');
  if (commentInput) {
    commentInput.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = this.scrollHeight + 'px';
    });
  }
});

// Toast 吐司通知
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerText = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'fadeIn 0.3s reverse ease forwards';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3500);
}

// 寫入活動日誌到雲端
async function logActivity(text) {
  if (!supabaseClient) return;
  try {
    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')} ${String(now.getMinutes()).padStart(2,'0')}`;
    
    await supabaseClient.from('activities').insert({
      text: text,
      timestamp: timeStr
    });
    
    await renderActivityLog();
    
    // 同步更新當前專案的任務更新日誌
    if (currentProject) {
      await renderTaskUpdateLog();
    }
  } catch (err) {
    console.error('無法寫入日誌:', err);
  }
}

// ==================== 4. 路由與視圖切換 ====================
async function navigateTo(viewId) {
  const panels = document.querySelectorAll('.view-panel');
  panels.forEach(p => p.classList.remove('active'));

  const activePanel = document.getElementById(viewId);
  if (activePanel) {
    activePanel.classList.add('active');
  }

  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    if (item.getAttribute('onclick') && item.getAttribute('onclick').includes(viewId)) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // 載入對應頁面的雲端資料
  if (viewId === 'mgr-dashboard-view' && currentUser && currentUser.role === 'manager') {
    await renderManagerDashboard();
  } else if (viewId === 'mgr-heatmap-view') {
    initHeatmapDropdown();
    await renderHeatmap();
  } else if (viewId === 'projects-view') {
    await initProjectsDashboard();
  } else if (viewId === 'rd-schedule-view' && currentUser && currentUser.role === 'rd') {
    initRdScheduleDropdown();
    await renderRdScheduleGrid();
  } else if (viewId === 'rd-report-view' && currentUser && currentUser.role === 'rd') {
    initRdReportDropdown();
    await loadUserReportByWeek();
  } else if (viewId === 'mgr-reports-view' && currentUser && currentUser.role === 'manager') {
    initReportsReviewDropdown();
    await renderReportsReview();
  }
}

// 根據角色渲染 Navbar 選單
function renderNavbar() {
  const navbarLinks = document.getElementById('navbar-links');
  navbarLinks.style.display = 'flex';
  navbarLinks.innerHTML = '';

  if (currentUser.role === 'manager') {
    navbarLinks.innerHTML = `
      <li><a class="nav-item active" onclick="navigateTo('mgr-dashboard-view')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
        團隊首頁
      </a></li>
      <li><a class="nav-item" onclick="navigateTo('mgr-heatmap-view')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        會議熱圖
      </a></li>
      <li><a class="nav-item" onclick="navigateTo('projects-view')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        專案看板 (Jira)
      </a></li>
      <li><a class="nav-item" onclick="navigateTo('mgr-reports-view')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        審查週報
      </a></li>
      <li><a class="nav-item" onclick="navigateTo('settings-view')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        備份還原
      </a></li>
    `;
  } else {
    navbarLinks.innerHTML = `
      <li><a class="nav-item active" onclick="navigateTo('rd-schedule-view')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        我的行程
      </a></li>
      <li><a class="nav-item" onclick="navigateTo('projects-view')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        任務看板 (Jira)
      </a></li>
      <li><a class="nav-item" onclick="navigateTo('rd-report-view')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        撰寫週報
      </a></li>
      <li><a class="nav-item" onclick="navigateTo('settings-view')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        備份還原
      </a></li>
    `;
  }
}

// 顯示登入狀態
async function showUserSession() {
  document.getElementById('auth-view').classList.remove('active');
  
  const userBadge = document.getElementById('user-badge');
  const userAvatar = document.getElementById('user-avatar');
  const userName = document.getElementById('user-name');
  
  userBadge.style.display = 'flex';
  userAvatar.innerText = currentUser.name.trim().charAt(0);
  userName.innerText = `${currentUser.name} (${currentUser.role === 'manager' ? '主管' : 'RD'})`;
  
  renderNavbar();

  // 若為主管登入，觸發雲端初始資料檢索與建立
  if (currentUser.role === 'manager') {
    await ensureDefaultUsersAndProjects();
    navigateTo('mgr-dashboard-view');
  } else {
    navigateTo('rd-schedule-view');
  }
}

// ==================== 5. 身份驗證邏輯 (登入、註冊、登出) ====================
let selectedRegisterRole = 'rd';

function switchAuthTab(tab) {
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');

  if (tab === 'login') {
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    formLogin.style.display = 'block';
    formRegister.style.display = 'none';
  } else {
    tabLogin.classList.remove('active');
    tabRegister.classList.add('active');
    formLogin.style.display = 'none';
    formRegister.style.display = 'block';
  }
}

function selectRegisterRole(role) {
  if (role === 'manager') return; // 鎖定 Manager 註冊，防範程式碼注入或惡意調用
  selectedRegisterRole = role;
  const roleRd = document.getElementById('role-rd');
  const roleMgr = document.getElementById('role-manager');

  if (role === 'rd') {
    roleRd.classList.add('active');
    roleMgr.classList.remove('active');
  } else {
    roleRd.classList.remove('active');
    roleMgr.classList.add('active');
  }
}

// 登入
async function handleLogin(e) {
  e.preventDefault();
  if (!supabaseClient) return;

  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  // 嘗試向 Supabase 進行登入
  let { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  
  // 自動化登入註冊 fallback (針對預設帳號，當其尚未在 Supabase Auth 建立時)
  if (error && error.message.includes('Invalid login credentials')) {
    const defaultUserSeed = DEFAULT_USERS.find(u => u.email.toLowerCase() === email.toLowerCase() && password === 'password');
    if (defaultUserSeed) {
      showToast('偵測到首次使用測試帳號，正在為您在雲端註冊此帳號...', 'info');
      
      const signupRes = await supabaseClient.auth.signUp({ email, password });
      
      if (!signupRes.error && signupRes.data.user) {
        // 同步寫入 profiles 表
        await supabaseClient.from('profiles').insert({
          id: signupRes.data.user.id,
          name: defaultUserSeed.name,
          email: defaultUserSeed.email,
          role: defaultUserSeed.role
        });

        // 重新進行登入
        const retryRes = await supabaseClient.auth.signInWithPassword({ email, password });
        data = retryRes.data;
        error = retryRes.error;
      }
    }
  }

  if (error) {
    showToast(`登入失敗：${error.message}，若為新帳號請先註冊。`, 'danger');
  } else if (data && data.user) {
    // 獲取該使用者的 profiles
    const { data: profile, error: pError } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();

    if (profile) {
      currentUser = profile;
      await showUserSession();
      showToast(`歡迎回來，${currentUser.name}！`, 'success');
      await logActivity(`${currentUser.name} 登入了系統。`);
    } else {
      // 有 auth 但無 profile 時（例外狀況，補建）
      const defaultUserSeed = DEFAULT_USERS.find(u => u.email.toLowerCase() === email.toLowerCase());
      const role = defaultUserSeed ? defaultUserSeed.role : 'rd';
      const name = defaultUserSeed ? defaultUserSeed.name : '研發人員';
      
      await supabaseClient.from('profiles').insert({
        id: data.user.id,
        name: name,
        email: email,
        role: role
      });
      
      const retryProfile = await supabaseClient.from('profiles').select('*').eq('id', data.user.id).single();
      currentUser = retryProfile.data;
      await showUserSession();
    }
  }
}

// 註冊
async function handleRegister(e) {
  e.preventDefault();
  if (!supabaseClient) return;

  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirm = document.getElementById('reg-confirm').value;

  if (password.length < 6) {
    showToast('密碼長度必須大於等於 6 個字元。', 'warning');
    return;
  }
  if (password !== confirm) {
    showToast('兩次密碼輸入不一致。', 'warning');
    return;
  }

  // 註冊 Supabase Auth 帳號
  const { data, error } = await supabaseClient.auth.signUp({ email, password });
  
  if (error) {
    showToast(`註冊失敗：${error.message}`, 'danger');
    return;
  }

  if (data && data.user) {
    // 建立 profiles 表資訊，全面鎖定註冊角色為 rd
    const { error: pError } = await supabaseClient.from('profiles').insert({
      id: data.user.id,
      name: name,
      email: email,
      role: 'rd'
    });

    if (pError) {
      showToast(`建立設定檔失敗：${pError.message}`, 'danger');
      return;
    }

    currentUser = {
      id: data.user.id,
      name: name,
      email: email,
      role: 'rd'
    };

    await showUserSession();
    showToast('註冊成功並已自動登入！', 'success');
    await logActivity(`新成員 ${currentUser.name} 自行註冊並加入了系統。`);

    document.getElementById('form-register').reset();
  }
}

// 登出按鈕
document.getElementById('btn-logout').addEventListener('click', async () => {
  if (!supabaseClient) return;
  if (currentUser) {
    await logActivity(`${currentUser.name} 登出了系統。`);
  }
  await supabaseClient.auth.signOut();
  currentUser = null;
  document.getElementById('user-badge').style.display = 'none';
  document.getElementById('navbar-links').style.display = 'none';
  navigateTo('auth-view');
  showToast('您已成功登出系統。', 'info');
});

// ==================== 6. 管理者：首頁概覽渲染 ====================
async function renderManagerDashboard() {
  if (!supabaseClient) return;
  try {
    const { data: allProfiles } = await supabaseClient.from('profiles').select('*');
    const rds = allProfiles ? allProfiles.filter(u => u.role === 'rd') : [];
    
    const { data: projects } = await supabaseClient.from('projects').select('*');
    const { data: tasks } = await supabaseClient.from('tasks').select('*');
    const { data: reports } = await supabaseClient.from('reports').select('*').eq('week_id', selectedWeekId);
    const { data: schedules } = await supabaseClient.from('schedules').select('*').eq('week_id', selectedWeekId);

    document.getElementById('stat-rd-count').innerText = rds.length;
    document.getElementById('stat-project-count').innerText = projects ? projects.length : 0;
    document.getElementById('stat-task-count').innerText = tasks ? tasks.length : 0;

    // 計算 Blocker 數量
    let blockerCount = 0;
    if (reports) {
      reports.forEach(r => {
        if (r.problems_text && r.problems_text.trim() !== '' && r.problems_text.trim() !== '無' && !r.problems_text.includes('沒有')) {
          blockerCount++;
        }
      });
    }
    document.getElementById('stat-blocker-count').innerText = blockerCount;

    // 渲染 RD 成員狀態
    const teamList = document.getElementById('team-status-list');
    teamList.innerHTML = '';

    if (rds.length === 0) {
      teamList.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 2rem;">目前尚無 RD 成員註冊。</div>`;
    } else {
      rds.forEach(rd => {
        const schedule = schedules ? schedules.find(s => s.user_id === rd.id) : null;
        const isScheduleUpdated = schedule ? 'yes' : 'no';
        const scheduleLabel = schedule ? '已更新行程' : '未上傳行程';

        const report = reports ? reports.find(r => r.user_id === rd.id) : null;
        const isReportSubmitted = report ? 'yes' : 'no';
        const reportLabel = report ? '已提交週報' : '未提交週報';

        const row = document.createElement('div');
        row.className = 'team-member-row';
        row.innerHTML = `
          <div class="member-info">
            <div class="avatar" style="width: 32px; height: 32px; font-size: 0.9rem;">${rd.name.charAt(0)}</div>
            <div>
              <div style="font-weight: 600;">${rd.name}</div>
              <div style="font-size: 0.75rem; color: var(--text-muted);">${rd.email}</div>
            </div>
          </div>
          <div class="member-status-tags" style="display: flex; align-items: center; gap: 0.5rem;">
            <span class="badge-tag ${isScheduleUpdated}">${scheduleLabel}</span>
            <span class="badge-tag ${isReportSubmitted}">${reportLabel}</span>
            <button class="btn btn-danger btn-sm" onclick="handleDeleteRd('${rd.id}')" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; background: transparent; border: 1px solid var(--danger); color: var(--danger); border-radius: 4px;" title="刪除此 RD">
              刪除
            </button>
          </div>
        `;
        teamList.appendChild(row);
      });
    }

    await renderActivityLog();
  } catch (err) {
    console.error('載入主管 Dashboard 失敗:', err);
  }
}

async function renderActivityLog() {
  if (!supabaseClient) return;
  const logContainer = document.getElementById('activity-log');
  if (!logContainer) return;

  logContainer.innerHTML = '';
  
  // 從 Supabase 取得最近 20 筆日誌
  const { data: activities, error } = await supabaseClient
    .from('activities')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error || !activities || activities.length === 0) {
    logContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 1rem;">尚無活動日誌。</div>`;
  } else {
    activities.forEach(act => {
      const item = document.createElement('div');
      item.className = 'activity-item';
      item.innerHTML = `
        <div>${act.text}</div>
        <div class="activity-time">${act.timestamp}</div>
      `;
      logContainer.appendChild(item);
    });
  }
}

// ==================== 任務更新日誌 ====================
let currentLogFilter = 'all';

function setLogFilter(filter) {
  currentLogFilter = filter;
  const btnAll = document.getElementById('log-filter-all');
  const btnMine = document.getElementById('log-filter-mine');
  if (btnAll && btnMine) {
    if (filter === 'all') {
      btnAll.classList.add('active');
      btnMine.classList.remove('active');
    } else {
      btnAll.classList.remove('active');
      btnMine.classList.add('active');
    }
  }
  renderTaskUpdateLog();
}

function formatLogDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
}

async function renderTaskUpdateLog() {
  if (!supabaseClient || !currentProject) {
    const container = document.getElementById('project-task-updates');
    if (container) container.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 1rem;">請先選擇專案。</div>';
    return;
  }

  const container = document.getElementById('project-task-updates');
  if (!container) return;

  // 1. 取得當前專案的所有任務
  const { data: projectTasks, error: taskErr } = await supabaseClient
    .from('tasks')
    .select('*')
    .eq('project_id', currentProject.id);

  if (taskErr || !projectTasks || projectTasks.length === 0) {
    container.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 1rem;">此專案尚無任務，無更新日誌。</div>';
    return;
  }

  const taskIds = projectTasks.map(t => t.id);
  const tasksMap = {};
  projectTasks.forEach(t => {
    tasksMap[t.id] = t;
  });

  // 2. 從 Supabase 取得最近 100 筆活動日誌
  const { data: activities } = await supabaseClient
    .from('activities')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  // 3. 從 Supabase 取得最近 100 筆留言
  const { data: comments } = await supabaseClient
    .from('task_comments')
    .select('*')
    .in('task_id', taskIds)
    .order('created_at', { ascending: false })
    .limit(100);

  const mergedLogs = [];

  // 處理活動日誌：找出屬於此專案中任務的活動
  if (activities) {
    activities.forEach(act => {
      // 比對是否有任務標題在活動文字中 (例如：「任務名稱」)
      const matchedTask = projectTasks.find(t => act.text.includes(`「${t.title}」`) || act.text.includes(t.title));
      if (matchedTask) {
        const dateVal = act.created_at ? new Date(act.created_at) : new Date();
        mergedLogs.push({
          id: 'act-' + act.id,
          type: 'activity',
          taskId: matchedTask.id,
          taskTitle: matchedTask.title,
          text: act.text,
          timestamp: act.timestamp || formatLogDate(dateVal),
          created_at: act.created_at || dateVal.toISOString()
        });
      }
    });
  }

  // 處理留言：排除檔案上傳留言
  if (comments) {
    comments.forEach(cmt => {
      if (cmt.text && cmt.text.startsWith('[file-attachment]')) {
        return;
      }

      const matchedTask = tasksMap[cmt.task_id];
      if (matchedTask) {
        const dateVal = new Date(cmt.created_at);
        const timeStr = formatLogDate(dateVal);
        mergedLogs.push({
          id: 'cmt-' + cmt.id,
          type: 'comment',
          taskId: matchedTask.id,
          taskTitle: matchedTask.title,
          text: `${cmt.sender_name} 在任務「${matchedTask.title}」中留言：「${cmt.text}」`,
          timestamp: timeStr,
          created_at: cmt.created_at
        });
      }
    });
  }

  // 排序 mergedLogs，按時間由新到舊
  mergedLogs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // 4. 根據目前登入的使用者進行篩選
  let filteredLogs = mergedLogs;
  if (currentLogFilter === 'mine' && currentUser) {
    filteredLogs = mergedLogs.filter(log => {
      const task = tasksMap[log.taskId];
      if (task) {
        const { assignees } = parseTaskMetadata(task);
        return assignees.includes(currentUser.id);
      }
      return false;
    });
  }

  if (filteredLogs.length === 0) {
    container.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 1rem;">尚無符合條件的更新日誌。</div>';
    return;
  }

  container.innerHTML = '';
  filteredLogs.forEach(log => {
    const task = tasksMap[log.taskId];
    const { assignees } = parseTaskMetadata(task);
    const isMine = currentUser && assignees.includes(currentUser.id);

    const item = document.createElement('div');
    item.className = 'activity-item';
    item.style.position = 'relative';
    if (isMine) {
      item.style.borderLeft = '4px solid var(--primary)';
      item.style.background = 'rgba(99, 102, 241, 0.03)';
    }

    const myTaskBadge = isMine 
      ? `<span class="task-badge" style="background: var(--primary-glow); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.3); margin-right: 0.5rem; font-size: 0.7rem; padding: 0px 4px;">與我相關</span>` 
      : '';

    item.innerHTML = `
      <div style="display: flex; align-items: flex-start; justify-content: space-between;">
        <div style="flex: 1;">
          <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 0.25rem; margin-bottom: 0.25rem;">
            ${myTaskBadge}
            <span style="font-weight: 600; font-size: 0.8rem; color: var(--text-muted); cursor: pointer; text-decoration: underline;" onclick="openTaskDetailModal('${log.taskId}')">#${log.taskId.substring(0, 5).toUpperCase()}</span>
          </div>
          <div style="color: var(--text-main); font-size: 0.9rem; line-height: 1.4;">${log.text}</div>
        </div>
      </div>
      <div class="activity-time" style="margin-top: 0.4rem;">${log.timestamp}</div>
    `;
    container.appendChild(item);
  });
}

// ==================== 7. 行程日曆渲染與邏輯 ====================
function initRdScheduleDropdown() {
  const select = document.getElementById('rd-week-select');
  select.innerHTML = '';
  currentWeeks.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.value;
    opt.innerText = w.label;
    opt.selected = w.value === selectedWeekId;
    select.appendChild(opt);
  });
}

function handleRdWeekChange() {
  selectedWeekId = document.getElementById('rd-week-select').value;
  renderRdScheduleGrid();
}

let tempRdSchedule = null;

async function renderRdScheduleGrid() {
  if (!supabaseClient) return;
  const grid = document.getElementById('rd-schedule-grid');
  grid.innerHTML = '';

  const cornerCell = document.createElement('div');
  cornerCell.className = 'grid-cell grid-header';
  cornerCell.innerText = '時段 / 星期';
  grid.appendChild(cornerCell);

  const weekInfo = currentWeeks.find(w => w.value === selectedWeekId);
  const mondayDate = weekInfo ? new Date(weekInfo.monday) : null;

  Object.keys(WEEKDAYS).forEach((dayKey, index) => {
    const dayName = WEEKDAYS[dayKey];
    let dateStr = '';
    if (mondayDate) {
      const targetDate = new Date(mondayDate.getTime() + index * 24 * 60 * 60 * 1000);
      dateStr = ` (${targetDate.getMonth() + 1}/${targetDate.getDate()})`;
    }
    
    const dayCell = document.createElement('div');
    dayCell.className = 'grid-cell grid-header';
    dayCell.innerText = `${dayName}${dateStr}`;
    grid.appendChild(dayCell);
  });

  // 從 Supabase 讀取行程
  const { data: schedule } = await supabaseClient
    .from('schedules')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('week_id', selectedWeekId)
    .single();

  let userSchedule = schedule;
  if (!userSchedule) {
    userSchedule = {
      user_id: currentUser.id,
      week_id: selectedWeekId,
      days: {
        monday: Array(10).fill(0),
        tuesday: Array(10).fill(0),
        wednesday: Array(10).fill(0),
        thursday: Array(10).fill(0),
        friday: Array(10).fill(0)
      }
    };
  }

  // 強制設定中午 12:00-13:00 (索引 4) 為休息時間 (state 3)
  Object.keys(WEEKDAYS).forEach(dayKey => {
    if (userSchedule.days && userSchedule.days[dayKey]) {
      userSchedule.days[dayKey][4] = 3;
    }
  });

  tempRdSchedule = JSON.parse(JSON.stringify(userSchedule));

  for (let slotIndex = 0; slotIndex < 10; slotIndex++) {
    const timeCell = document.createElement('div');
    timeCell.className = 'grid-cell time-label';
    timeCell.innerText = HOUR_SLOTS[slotIndex];
    grid.appendChild(timeCell);

    Object.keys(WEEKDAYS).forEach(dayKey => {
      const state = tempRdSchedule.days[dayKey][slotIndex];
      const cell = document.createElement('div');
      cell.className = 'grid-cell';

      const card = document.createElement('div');
      card.className = `slot-card state-${state}`;
      card.id = `slot-${dayKey}-${slotIndex}`;
      card.innerText = getSlotStateText(state);

      if (slotIndex === 4) {
        // 鎖定休息時間不允許編輯
        card.className = 'slot-card state-3';
        card.style.cursor = 'not-allowed';
      } else {
        card.addEventListener('click', () => {
          let currState = tempRdSchedule.days[dayKey][slotIndex];
          let nextState = (currState + 1) % 3;
          tempRdSchedule.days[dayKey][slotIndex] = nextState;
          
          card.className = `slot-card state-${nextState}`;
          card.innerText = getSlotStateText(nextState);
        });
      }

      cell.appendChild(card);
      grid.appendChild(cell);
    });
  }
}

function getSlotStateText(state) {
  if (state === 1) return '會議/忙碌';
  if (state === 2) return '有課程上課';
  if (state === 3) return '休息時間';
  return '空閒/工作';
}

async function saveRdSchedule() {
  if (!supabaseClient || !tempRdSchedule) return;

  const { error } = await supabaseClient.from('schedules').upsert({
    user_id: currentUser.id,
    week_id: selectedWeekId,
    days: tempRdSchedule.days
  });

  if (error) {
    showToast(`儲存失敗：${error.message}`, 'danger');
  } else {
    showToast('本週行程已儲存成功！', 'success');
    await logActivity(`${currentUser.name} 儲存了 ${selectedWeekId} 的上課與忙碌行程。`);
  }
}

// ==================== 8. 管理者：行程熱圖 Solver 邏輯 ====================
function initHeatmapDropdown() {
  const select = document.getElementById('heatmap-week-select');
  select.innerHTML = '';
  currentWeeks.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.value;
    opt.innerText = w.label;
    opt.selected = w.value === selectedWeekId;
    select.appendChild(opt);
  });
}

async function renderHeatmap() {
  if (!supabaseClient) return;
  const select = document.getElementById('heatmap-week-select');
  if (select) selectedWeekId = select.value;

  const grid = document.getElementById('heatmap-grid');
  grid.innerHTML = '';

  const cornerCell = document.createElement('div');
  cornerCell.className = 'grid-cell grid-header';
  cornerCell.innerText = '時段 / 星期';
  grid.appendChild(cornerCell);

  const weekInfo = currentWeeks.find(w => w.value === selectedWeekId);
  const mondayDate = weekInfo ? new Date(weekInfo.monday) : null;

  Object.keys(WEEKDAYS).forEach((dayKey, index) => {
    const dayName = WEEKDAYS[dayKey];
    let dateStr = '';
    if (mondayDate) {
      const targetDate = new Date(mondayDate.getTime() + index * 24 * 60 * 60 * 1000);
      dateStr = ` (${targetDate.getMonth() + 1}/${targetDate.getDate()})`;
    }
    
    const dayCell = document.createElement('div');
    dayCell.className = 'grid-cell grid-header';
    dayCell.innerText = `${dayName}${dateStr}`;
    grid.appendChild(dayCell);
  });

  // 取得 RD 與其行程
  const { data: allProfiles } = await supabaseClient.from('profiles').select('*');
  const rds = allProfiles ? allProfiles.filter(u => u.role === 'rd') : [];
  
  const { data: schedules } = await supabaseClient
    .from('schedules')
    .select('*')
    .eq('week_id', selectedWeekId);

  for (let slotIndex = 0; slotIndex < 10; slotIndex++) {
    const timeCell = document.createElement('div');
    timeCell.className = 'grid-cell time-label';
    timeCell.innerText = HOUR_SLOTS[slotIndex];
    grid.appendChild(timeCell);

    Object.keys(WEEKDAYS).forEach(dayKey => {
      const cell = document.createElement('div');
      cell.className = 'grid-cell';

      const card = document.createElement('div');

      if (slotIndex === 4) {
        // 中午休息時段
        card.className = 'slot-card state-3';
        card.innerHTML = '<span style="font-weight:700;">休息時間</span>';
        cell.appendChild(card);
        grid.appendChild(cell);
        return;
      }

      let busyCount = 0;
      let syncCount = 0;
      let busyNames = [];
      let syncNames = [];

      if (schedules) {
        schedules.forEach(sched => {
          const rdInfo = rds.find(r => r.id === sched.user_id);
          const name = rdInfo ? rdInfo.name : '未知';
          const state = (sched.days && sched.days[dayKey]) ? sched.days[dayKey][slotIndex] : 0;

          if (state === 1) {
            busyCount++;
            busyNames.push(name);
          } else if (state === 2) {
            syncCount++;
            syncNames.push(name);
          }
        });
      }

      card.className = 'slot-card';
      
      if (busyCount > 0 || syncCount > 0) {
        let labelText = '';
        let tooltipNames = [];
        let cardClass = 'slot-card';

        if (busyCount > 0 && syncCount > 0) {
          labelText = `${busyCount}人開會/${syncCount}人上課`;
          tooltipNames = [...busyNames, ...syncNames];
          cardClass += ' hotspot-block';
        } else if (busyCount > 0) {
          labelText = `${busyCount}人會議中`;
          tooltipNames = busyNames;
          cardClass += ' hotspot-block';
        } else {
          labelText = `${syncCount}人上課中`;
          tooltipNames = syncNames;
          cardClass += ' hotspot-mid';
        }

        card.className = cardClass;
        card.innerHTML = `<span style="font-weight:700;">${labelText}</span><span style="font-size:0.65rem; opacity:0.8;">(${tooltipNames.join(',')})</span>`;
      } else if (rds.length > 0) {
        card.className = 'slot-card hotspot-high';
        card.innerHTML = `<span style="font-weight:700;">🌟 最佳時段</span><span style="font-size:0.65rem;">(全員空閒)</span>`;
      } else {
        card.className = 'slot-card state-0';
        card.innerText = '空閒/工作';
      }

      cell.appendChild(card);
      grid.appendChild(cell);
    });
  }
}

// ==================== 9. Jira-Lite 專案與子細目任務看板 ====================
async function initProjectsDashboard() {
  if (!supabaseClient) return;
  
  let projects = [];
  if (currentUser.role === 'manager') {
    const { data } = await supabaseClient.from('projects').select('*').order('created_at', { ascending: true });
    projects = data || [];
  } else {
    // Current user is an RD, only show projects they are members of
    const { data: memberRows } = await supabaseClient
      .from('project_members')
      .select('project_id')
      .eq('user_id', currentUser.id);
    
    const prjIds = memberRows ? memberRows.map(r => r.project_id) : [];
    if (prjIds.length > 0) {
      const { data } = await supabaseClient
        .from('projects')
        .select('*')
        .in('id', prjIds)
        .order('created_at', { ascending: true });
      projects = data || [];
    }
  }

  const select = document.getElementById('project-select');
  
  const createPrjBtn = document.getElementById('btn-create-project');
  const createTskBtn = document.getElementById('btn-create-task');
  const manageMemBtn = document.getElementById('btn-manage-members');
  const deletePrjBtn = document.getElementById('btn-delete-project');
  
  if (currentUser.role === 'manager') {
    createPrjBtn.style.display = 'inline-flex';
    createTskBtn.style.display = 'inline-flex';
    manageMemBtn.style.display = 'inline-flex';
    if (deletePrjBtn) deletePrjBtn.style.display = 'inline-flex';
  } else {
    createPrjBtn.style.display = 'none';
    // RD can create tasks if a project exists for them
    createTskBtn.style.display = (projects && projects.length > 0) ? 'inline-flex' : 'none';
    manageMemBtn.style.display = 'none';
    if (deletePrjBtn) deletePrjBtn.style.display = 'none';
  }

  select.innerHTML = '';
  if (!projects || projects.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.innerText = '尚無任何專案';
    select.appendChild(opt);
    currentProject = null;
    clearProjectBoard();
    if (deletePrjBtn) deletePrjBtn.style.display = 'none';
    if (manageMemBtn) manageMemBtn.style.display = 'none';
    if (createTskBtn) createTskBtn.style.display = 'none';
    return;
  }

  projects.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.innerText = p.name;
    select.appendChild(opt);
  });

  if (currentProject && projects.some(p => p.id === currentProject.id)) {
    select.value = currentProject.id;
  } else {
    currentProject = projects[0];
    select.value = currentProject.id;
  }

  await renderProjectBoard();
}

function handleProjectChange() {
  if (!supabaseClient) return;
  const projectId = document.getElementById('project-select').value;
  supabaseClient.from('projects').select('*').eq('id', projectId).single().then(res => {
    currentProject = res.data;
    renderProjectBoard();
  });
}

function clearProjectBoard() {
  document.getElementById('project-desc-text').innerText = '無描述';
  document.getElementById('project-members-list').innerHTML = '';
  document.querySelectorAll('.column-cards').forEach(col => col.innerHTML = '');
  document.querySelectorAll('.column-count').forEach(c => c.innerText = '0');
  const announcementBanner = document.getElementById('project-announcement-banner');
  if (announcementBanner) {
    announcementBanner.style.display = 'none';
  }
}

// 解析專案詮釋資料 (公佈欄內容)
function parseProjectMetadata(project) {
  let description = project.description || '';
  let announcement = '';
  if (description.includes('\n\n[announcement]')) {
    const parts = description.split('\n\n[announcement]');
    description = parts[0];
    announcement = parts[1] || '';
  }
  return { description, announcement };
}

// 解析任務詮釋資料 (多負責人與進度履歷)
function parseTaskMetadata(task) {
  let description = task.description || '';
  let assignees = [];
  let progress = {
    percent: 0,
    history: []
  };

  // 1. 先解析 progress (如果存在，它應該在最尾端)
  if (description.includes('\n\n[progress]')) {
    const parts = description.split('\n\n[progress]');
    description = parts[0];
    try {
      progress = JSON.parse(parts[1]);
    } catch (e) {
      console.error('解析進度資料錯誤:', e);
    }
  }

  // 2. 再解析 assignees
  if (description.includes('\n\n[assignees]')) {
    const parts = description.split('\n\n[assignees]');
    description = parts[0];
    try {
      assignees = JSON.parse(parts[1]);
    } catch (e) {
      console.error('解析多負責人錯誤:', e);
    }
  }

  // 向下相容舊有資料：若無標記，則取單一 assignee_id
  if (assignees.length === 0 && task.assignee_id) {
    assignees.push(task.assignee_id);
  }

  return { description, assignees, progress };
}

async function renderProjectBoard() {
  if (!currentProject || !supabaseClient) {
    clearProjectBoard();
    return;
  }

  document.getElementById('project-board-title').innerText = `${currentProject.name} 任務看板`;
  
  const { description: cleanDesc, announcement } = parseProjectMetadata(currentProject);
  document.getElementById('project-desc-text').innerText = cleanDesc || '無描述';

  // 專案公佈欄
  const announcementBanner = document.getElementById('project-announcement-banner');
  if (announcementBanner) {
    announcementBanner.style.display = 'block';
    const announcementContent = document.getElementById('project-announcement-content');
    if (announcementContent) {
      if (announcement && announcement.trim() !== '') {
        announcementContent.innerText = announcement;
      } else {
        announcementContent.innerText = '目前無公告事項。';
      }
    }
    
    // 控制編輯按鈕顯示 (僅管理員/專案負責人可編輯)
    const editAnnouncementBtn = document.getElementById('btn-edit-announcement');
    if (editAnnouncementBtn) {
      if (currentUser && (currentUser.role === 'manager' || currentUser.id === currentProject.manager_id)) {
        editAnnouncementBtn.style.display = 'inline-block';
      } else {
        editAnnouncementBtn.style.display = 'none';
      }
    }
  }

  // 抓取成員
  const { data: memberRows } = await supabaseClient
    .from('project_members')
    .select('user_id, profiles(name, email)')
    .eq('project_id', currentProject.id);

  const membersList = document.getElementById('project-members-list');
  membersList.innerHTML = '';

  const projectMemberIds = [];
  if (memberRows) {
    memberRows.forEach(row => {
      projectMemberIds.push(row.user_id);
      const profile = row.profiles;
      if (profile) {
        const av = document.createElement('div');
        av.className = 'avatar';
        av.style.width = '24px';
        av.style.height = '24px';
        av.style.fontSize = '0.7rem';
        av.innerText = profile.name.charAt(0);
        av.title = `${profile.name} (${profile.email})`;
        membersList.appendChild(av);
      }
    });
  }

  currentProject.members = projectMemberIds;

  // 抓取看板任務
  const { data: projectTasks } = await supabaseClient
    .from('tasks')
    .select('*')
    .eq('project_id', currentProject.id);

  const { data: allProfiles } = await supabaseClient.from('profiles').select('*');

  const cols = {
    todo: document.getElementById('col-todo'),
    inprogress: document.getElementById('col-inprogress'),
    review: document.getElementById('col-review'),
    done: document.getElementById('col-done')
  };

  Object.values(cols).forEach(el => el.innerHTML = '');
  const counts = { todo: 0, inprogress: 0, review: 0, done: 0 };

  if (projectTasks) {
    projectTasks.forEach(task => {
      const { description: cleanDesc, assignees, progress } = parseTaskMetadata(task);
      const card = document.createElement('div');
      card.className = 'task-card';
      card.draggable = true;
      card.id = `task-card-${task.id}`;
      
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', task.id);
      });

      card.addEventListener('click', () => {
        openTaskDetailModal(task.id);
      });

      const typeLabels = { task: '任務', bug: 'Bug', test: '測試' };
      
      // 根據負責人人數動態生成 HTML
      let assigneeHtml = '';
      if (assignees.length > 0) {
        const avatars = assignees.map(id => {
          const user = allProfiles ? allProfiles.find(u => u.id === id) : null;
          if (user) {
            const char = user.name.charAt(0);
            return `<div class="mini-avatar" title="${user.name}">${char}</div>`;
          }
          return '';
        }).join('');
        
        let label = '';
        if (assignees.length === 1) {
          const user = allProfiles ? allProfiles.find(u => u.id === assignees[0]) : null;
          label = user ? user.name : '未知';
        } else {
          label = `${assignees.length} 位負責人`;
        }
        
        assigneeHtml = `
          <div class="task-assignee">
            <div class="avatar-group">${avatars}</div>
            <span>${label}</span>
          </div>
        `;
      } else {
        assigneeHtml = `
          <div class="task-assignee">
            <div class="mini-avatar">?</div>
            <span>未指派</span>
          </div>
        `;
      }

      // 進度小標籤
      let progressBadge = '';
      if (progress && progress.percent > 0) {
        progressBadge = `<span class="task-badge" style="background: rgba(16, 185, 129, 0.1); color: var(--success); margin-left: 0.35rem; border: 1px solid rgba(16, 185, 129, 0.2);">${progress.percent}%</span>`;
      }

      card.innerHTML = `
        <div class="task-card-header">
          <div>
            <span class="task-badge ${task.type}">${typeLabels[task.type]}</span>
            ${progressBadge}
          </div>
          <div class="task-priority ${task.priority}" title="優先權：${task.priority}"></div>
        </div>
        <div class="task-card-title">${task.title}</div>
        <div class="task-card-footer">
          <span style="font-size:0.75rem; color:var(--text-muted);">#${task.id.substring(0, 5).toUpperCase()}</span>
          ${assigneeHtml}
        </div>
      `;

      if (cols[task.status]) {
        cols[task.status].appendChild(card);
        counts[task.status]++;
      }
    });
  }

  document.getElementById('count-todo').innerText = counts.todo;
  document.getElementById('count-inprogress').innerText = counts.inprogress;
  document.getElementById('count-review').innerText = counts.review;
  document.getElementById('count-done').innerText = counts.done;
  await renderTaskUpdateLog();
}

function allowDrop(e) {
  e.preventDefault();
}

async function drop(e, newStatus) {
  e.preventDefault();
  if (!supabaseClient) return;

  const taskId = e.dataTransfer.getData('text/plain');
  const { data: task } = await supabaseClient.from('tasks').select('*').eq('id', taskId).single();
  if (!task) return;

  const { assignees } = parseTaskMetadata(task);
  if (currentUser.role === 'rd' && !assignees.includes(currentUser.id)) {
    showToast('操作限制：您只能修改被指派給您自己的任務狀態。', 'warning');
    return;
  }

  const oldStatus = task.status;
  const { error } = await supabaseClient.from('tasks').update({ status: newStatus }).eq('id', taskId);

  if (error) {
    showToast(`任務移動失敗：${error.message}`, 'danger');
  } else {
    showToast(`任務已移至 ${newStatus}`, 'success');
    await logActivity(`${currentUser.name} 將任務「${task.title}」狀態從 [${oldStatus}] 變更為 [${newStatus}]。`);
    await renderProjectBoard();
  }
}

// 開啟編輯專案公告 Modal
function openEditAnnouncementModal() {
  if (!currentProject) return;
  const { announcement } = parseProjectMetadata(currentProject);
  document.getElementById('announcement-text').value = announcement || '';
  document.getElementById('modal-edit-announcement').classList.add('active');
}

// 儲存專案公告
async function handleSaveAnnouncement(e) {
  e.preventDefault();
  if (!supabaseClient || !currentProject) return;

  const text = document.getElementById('announcement-text').value.trim();
  const { description: cleanDesc } = parseProjectMetadata(currentProject);

  let newDescription = cleanDesc;
  if (text) {
    newDescription += '\n\n[announcement]' + text;
  }

  const { error } = await supabaseClient
    .from('projects')
    .update({ description: newDescription })
    .eq('id', currentProject.id);

  if (error) {
    showToast('更新公告失敗: ' + error.message, 'danger');
  } else {
    showToast('更新公告成功！', 'success');
    closeModal('modal-edit-announcement');
    
    // 更新本地專案資料並重新渲染
    currentProject.description = newDescription;
    renderProjectBoard();
    
    await logActivity(`${currentUser.name} 更新了專案「${currentProject.name}」的公佈欄公告。`);
  }
}

// 開啟新增專案 Modal
async function openCreateProjectModal() {
  if (!currentUser || currentUser.role !== 'manager') return;
  
  // 獲取所有 RD 成員供選擇
  const { data: allProfiles } = await supabaseClient.from('profiles').select('*');
  const rds = allProfiles ? allProfiles.filter(u => u.role === 'rd') : [];
  
  const group = document.getElementById('create-project-members-group');
  group.innerHTML = '';
  
  if (rds.length === 0) {
    group.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem;">目前系統中無任何註冊的 RD 成員。</div>';
  } else {
    rds.forEach(rd => {
      const label = document.createElement('label');
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.gap = '0.5rem';
      label.style.cursor = 'pointer';
      label.innerHTML = `
        <input type="checkbox" name="new-project-rd" value="${rd.id}" style="width:16px; height:16px;">
        <span>${rd.name} (${rd.email})</span>
      `;
      group.appendChild(label);
    });
  }
  
  document.getElementById('modal-create-project').classList.add('active');
}

// 建立新專案
async function handleCreateProject(e) {
  e.preventDefault();
  if (!supabaseClient) return;

  const name = document.getElementById('new-project-name').value.trim();
  const desc = document.getElementById('new-project-desc').value.trim();

  // 取得勾選的 RD 成員
  const checkboxes = document.querySelectorAll('input[name="new-project-rd"]:checked');
  if (checkboxes.length === 0) {
    showToast('建立專案失敗：建立新專案必須至少包含一位 RD。', 'warning');
    return;
  }
  
  const selectedRds = Array.from(checkboxes).map(cb => cb.value);

  const { data, error } = await supabaseClient.from('projects').insert({
    name: name,
    description: desc,
    manager_id: currentUser.id
  }).select();

  if (error) {
    showToast(`建立專案失敗：${error.message}`, 'danger');
  } else if (data && data.length > 0) {
    const newPrj = data[0];
    
    // 將選中的 RD 加入專案成員
    const memberRows = selectedRds.map(rdId => ({
      project_id: newPrj.id,
      user_id: rdId
    }));
    
    const { error: memError } = await supabaseClient.from('project_members').insert(memberRows);
    if (memError) {
      showToast(`加入成員失敗：${memError.message}`, 'danger');
    }
    
    showToast(`成功建立專案：${name}`, 'success');
    await logActivity(`${currentUser.name} 建立了新專案「${name}」並指派了 ${selectedRds.length} 位 RD。`);
    
    closeModal('modal-create-project');
    document.getElementById('new-project-name').value = '';
    document.getElementById('new-project-desc').value = '';
    
    currentProject = newPrj;
    await initProjectsDashboard();
  }
}

// 開啟成員管理
async function openManageMembersModal() {
  if (!currentProject || !supabaseClient) return;
  const modal = document.getElementById('modal-manage-members');
  document.getElementById('member-modal-title').innerText = `管理「${currentProject.name}」成員`;
  
  const { data: allProfiles } = await supabaseClient.from('profiles').select('*');
  const rds = allProfiles ? allProfiles.filter(u => u.role === 'rd') : [];
  
  const group = document.getElementById('members-checkbox-group');
  group.innerHTML = '';

  if (rds.length === 0) {
    group.innerHTML = '<div style="color:var(--text-muted);">目前尚無註冊的 RD 可加入。</div>';
  } else {
    rds.forEach(rd => {
      const isMember = currentProject.members.includes(rd.id);
      const label = document.createElement('label');
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.gap = '0.5rem';
      label.style.cursor = 'pointer';
      label.innerHTML = `
        <input type="checkbox" value="${rd.id}" ${isMember ? 'checked' : ''} style="width:16px; height:16px;">
        <span>${rd.name} (${rd.email})</span>
      `;
      group.appendChild(label);
    });
  }

  modal.classList.add('active');
}

// 儲存成員
async function handleSaveMembers(e) {
  e.preventDefault();
  if (!currentProject || !supabaseClient) return;

  const group = document.getElementById('members-checkbox-group');
  const checkboxes = group.querySelectorAll('input[type="checkbox"]');
  const selectedMembers = [];
  
  checkboxes.forEach(cb => {
    if (cb.checked) selectedMembers.push(cb.value);
  });

  // 刪除該專案原本的成員
  await supabaseClient.from('project_members').delete().eq('project_id', currentProject.id);

  // 寫入新成員
  if (selectedMembers.length > 0) {
    const insertRows = selectedMembers.map(uid => ({ project_id: currentProject.id, user_id: uid }));
    await supabaseClient.from('project_members').insert(insertRows);
  }

  showToast('專案成員清單已更新！', 'success');
  await logActivity(`${currentUser.name} 修改了專案「${currentProject.name}」的成員名單。`);
  closeModal('modal-manage-members');
  await renderProjectBoard();
}

// 開啟建立任務視窗
async function openCreateTaskModal() {
  if (!currentProject || !supabaseClient) return;
  const modal = document.getElementById('modal-create-task');
  const assigneeGroup = document.getElementById('task-assignee-group');
  assigneeGroup.innerHTML = '';

  if (currentUser.role === 'rd') {
    // RD 只能指派任務給自己
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '0.5rem';
    label.style.cursor = 'not-allowed';
    label.innerHTML = `
      <input type="checkbox" name="task-assignees" value="${currentUser.id}" checked disabled style="width:16px; height:16px;">
      <span>${currentUser.name}</span>
    `;
    assigneeGroup.appendChild(label);
  } else {
    // 主管可以指派給專案內的所有成員
    const { data: memberRows } = await supabaseClient
      .from('project_members')
      .select('user_id, profiles(name, email)')
      .eq('project_id', currentProject.id);

    if (memberRows && memberRows.length > 0) {
      memberRows.forEach(row => {
        const profile = row.profiles;
        if (profile) {
          const label = document.createElement('label');
          label.style.display = 'flex';
          label.style.alignItems = 'center';
          label.style.gap = '0.5rem';
          label.style.cursor = 'pointer';
          label.innerHTML = `
            <input type="checkbox" name="task-assignees" value="${row.user_id}" style="width:16px; height:16px;">
            <span>${profile.name} (${profile.email})</span>
          `;
          assigneeGroup.appendChild(label);
        }
      });
    } else {
      assigneeGroup.innerHTML = '<span style="color:var(--text-muted); font-size:0.9rem;">專案內尚無成員</span>';
    }
  }

  toggleTaskTypeFields();
  modal.classList.add('active');
}
function toggleTaskTypeFields() {
  const type = document.getElementById('task-type').value;
  const bugFields = document.getElementById('bug-fields');
  const testFields = document.getElementById('test-fields');

  if (type === 'bug') {
    bugFields.style.display = 'block';
    testFields.style.display = 'none';
  } else if (type === 'test') {
    bugFields.style.display = 'none';
    testFields.style.display = 'block';
  } else {
    bugFields.style.display = 'none';
    testFields.style.display = 'none';
  }
}

// 建立新子細目任務
async function handleCreateTask(e) {
  e.preventDefault();
  if (!currentProject || !supabaseClient) return;

  const type = document.getElementById('task-type').value;
  const priority = document.getElementById('task-priority').value;
  const title = document.getElementById('task-title').value.trim();
  const desc = document.getElementById('task-desc').value.trim();

  // 取得勾選的 RD 成員
  const checkedBoxes = document.querySelectorAll('input[name="task-assignees"]:checked');
  const assigneeIds = Array.from(checkedBoxes).map(cb => cb.value);

  // RD 在 disabled checkbox 下會被 querySelector 漏掉或需要處理，保險起見若為空且為 RD 則自動加自己
  if (assigneeIds.length === 0 && currentUser.role === 'rd') {
    assigneeIds.push(currentUser.id);
  }

  if (assigneeIds.length === 0) {
    showToast('請至少選擇一位指派對象 (RD)。', 'warning');
    return;
  }

  // 安全防護：如果是 RD 只能包含自己
  if (currentUser.role === 'rd' && (assigneeIds.length > 1 || assigneeIds[0] !== currentUser.id)) {
    showToast('權限限制：RD 建立任務只能指派給自己！', 'warning');
    return;
  }

  // 組合 metadata 寫入 description 尾端，而 assignee_id 取第一個 UUID 滿足資料庫外鍵
  let descriptionToSend = desc;
  descriptionToSend += "\n\n[assignees]" + JSON.stringify(assigneeIds);

  const insertData = {
    project_id: currentProject.id,
    title: title,
    description: descriptionToSend,
    type: type,
    priority: priority,
    status: 'todo',
    assignee_id: assigneeIds[0]
  };

  if (type === 'bug') {
    insertData.bug_steps = document.getElementById('bug-steps').value.trim();
    insertData.bug_env = document.getElementById('bug-env').value.trim();
    insertData.bug_severity = document.getElementById('bug-severity').value;
  } else if (type === 'test') {
    insertData.test_cases = document.getElementById('test-cases').value.trim();
    insertData.test_platform = document.getElementById('test-platform').value.trim();
  }

  const { error } = await supabaseClient.from('tasks').insert(insertData);

  if (error) {
    showToast(`建立任務失敗：${error.message}`, 'danger');
  } else {
    showToast('子細目任務建立成功！', 'success');
    await logActivity(`${currentUser.name} 建立了專案任務「${title}」。`);

    closeModal('modal-create-task');
    document.getElementById('modal-create-task').querySelector('form').reset();
    await renderProjectBoard();
  }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

// ==================== 10. 任務詳細資訊與留言 ====================
async function openTaskDetailModal(taskId) {
  if (!supabaseClient) return;
  const { data: task } = await supabaseClient.from('tasks').select('*').eq('id', taskId).single();
  if (!task) return;

  currentTaskDetail = task;

  // 解析描述、負責人與進度
  const { description: cleanDesc, assignees, progress } = parseTaskMetadata(task);

  document.getElementById('detail-task-id').innerText = `#${task.id.substring(0, 5).toUpperCase()}`;
  document.getElementById('detail-task-title').innerText = task.title;
  document.getElementById('detail-task-desc').innerText = cleanDesc || '';
  document.getElementById('detail-task-status').value = task.status;
  document.getElementById('detail-task-priority-val').innerText = task.priority.toUpperCase();

  const { data: allProfiles } = await supabaseClient.from('profiles').select('*');
  
  // 顯示所有負責人的姓名列表
  const assigneeNames = [];
  assignees.forEach(id => {
    const user = allProfiles ? allProfiles.find(u => u.id === id) : null;
    if (user) {
      assigneeNames.push(user.name);
    }
  });
  document.getElementById('detail-task-assignee-val').innerText = assigneeNames.join(', ') || '未指派';

  // 渲染進度條
  const percent = progress ? progress.percent : 0;
  document.getElementById('detail-progress-percent').innerText = `${percent}%`;
  document.getElementById('detail-progress-bar').style.width = `${percent}%`;
  
  // 渲染進度歷史紀錄
  renderProgressTimeline(progress ? progress.history : []);

  // 判斷是否顯示進度填寫區 (限主管或指派的 RD 負責人)
  const showInputArea = currentUser.role === 'manager' || assignees.includes(currentUser.id);
  const inputArea = document.getElementById('progress-update-input-area');
  if (inputArea) {
    inputArea.style.display = showInputArea ? 'block' : 'none';
    // 重設表單值為目前進度
    document.getElementById('progress-update-percent').value = percent.toString();
    document.getElementById('progress-update-text').value = '';
    document.getElementById('progress-update-text').style.height = 'auto';
  }

  const delBtn = document.getElementById('btn-delete-task');
  delBtn.style.display = currentUser.role === 'manager' ? 'inline-block' : 'none';

  const badge = document.getElementById('detail-task-type-badge');
  badge.className = `task-badge ${task.type}`;
  badge.innerText = task.type.toUpperCase();

  const bugSection = document.getElementById('detail-bug-section');
  const testSection = document.getElementById('detail-test-section');

  if (task.type === 'bug') {
    bugSection.style.display = 'block';
    testSection.style.display = 'none';
    document.getElementById('detail-bug-steps-input').value = task.bug_steps || '';
    document.getElementById('detail-bug-env-input').value = task.bug_env || '';
    document.getElementById('detail-bug-severity-val').value = task.bug_severity || 'medium';
  } else if (task.type === 'test') {
    bugSection.style.display = 'none';
    testSection.style.display = 'block';
    document.getElementById('detail-test-cases-input').value = task.test_cases || '';
    document.getElementById('detail-test-results-input').value = task.test_results || '';
  } else {
    bugSection.style.display = 'none';
    testSection.style.display = 'none';
  }

  await renderComments();
  document.getElementById('modal-task-detail').classList.add('active');
}

// 提交任務進度更新
async function submitTaskProgressUpdate() {
  if (!currentTaskDetail || !supabaseClient) return;
  
  const percentSelect = document.getElementById('progress-update-percent');
  const textInput = document.getElementById('progress-update-text');
  
  const percentVal = parseInt(percentSelect.value, 10);
  const textVal = textInput.value.trim();
  
  if (!textVal) {
    showToast('請填寫最新進度描述說明。', 'warning');
    return;
  }
  
  const { description: cleanDesc, assignees, progress } = parseTaskMetadata(currentTaskDetail);
  
  // 檢查權限 (限主管與負責該任務的 RD)
  if (currentUser.role === 'rd' && !assignees.includes(currentUser.id)) {
    showToast('權限限制：您並非此任務的負責人，無法更新進度。', 'danger');
    return;
  }
  
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  
  // 新的歷史紀錄節點
  const newLog = {
    percent: percentVal,
    text: textVal,
    author: currentUser.name,
    timestamp: timeStr
  };
  
  // 更新進度物件
  const updatedProgress = {
    percent: percentVal,
    history: progress.history || []
  };
  updatedProgress.history.unshift(newLog); // 最新的排在前面
  
  // 重組 description：乾淨描述 + assignees 標記 + progress 標記
  let newDescription = cleanDesc;
  newDescription += "\n\n[assignees]" + JSON.stringify(assignees);
  newDescription += "\n\n[progress]" + JSON.stringify(updatedProgress);
  
  showToast('正在更新進度...', 'info');
  
  // 如果設定 100%，自動連動 status 為 'done'；如果大於 0% 且 status 為 'todo'，改為 'inprogress'
  let targetStatus = currentTaskDetail.status;
  if (percentVal === 100) {
    targetStatus = 'done';
  } else if (percentVal > 0 && targetStatus === 'todo') {
    targetStatus = 'inprogress';
  }
  
  const { error } = await supabaseClient.from('tasks').update({
    description: newDescription,
    status: targetStatus
  }).eq('id', currentTaskDetail.id);
  
  if (error) {
    showToast(`進度更新失敗：${error.message}`, 'danger');
  } else {
    showToast('進度更新成功！', 'success');
    textInput.value = ''; // 清空輸入框
    textInput.style.height = 'auto';
    
    // 記錄活動日誌
    await logActivity(`${currentUser.name} 回報了任務「${currentTaskDetail.title}」的進度為 ${percentVal}%，說明：${textVal}`);
    
    // 重新載入任務詳情與看板
    const { data: updatedTask } = await supabaseClient.from('tasks').select('*').eq('id', currentTaskDetail.id).single();
    if (updatedTask) {
      currentTaskDetail = updatedTask;
      
      // 更新詳情視窗 UI
      const { description: finalDesc, progress: finalProgress } = parseTaskMetadata(updatedTask);
      document.getElementById('detail-task-desc').innerText = finalDesc || '';
      document.getElementById('detail-task-status').value = updatedTask.status;
      
      // 重新渲染進度條與歷史紀錄
      document.getElementById('detail-progress-percent').innerText = `${finalProgress.percent}%`;
      document.getElementById('detail-progress-bar').style.width = `${finalProgress.percent}%`;
      renderProgressTimeline(finalProgress.history);
    }
    
    await renderProjectBoard();
  }
}

// 輔助渲染進度時間軸
function renderProgressTimeline(history) {
  const container = document.getElementById('detail-progress-logs');
  container.innerHTML = '';
  
  if (!history || history.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted); font-size:0.85rem;">尚無進度更新紀錄</span>';
    return;
  }
  
  history.forEach(log => {
    const item = document.createElement('div');
    item.style.background = 'rgba(255, 255, 255, 0.02)';
    item.style.border = '1px solid var(--border-color)';
    item.style.borderRadius = 'var(--radius-sm)';
    item.style.padding = '0.75rem';
    item.style.fontSize = '0.85rem';
    item.style.display = 'flex';
    item.style.flexDirection = 'column';
    item.style.gap = '0.25rem';
    
    item.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:600; color:var(--text-main);">${log.author} <span style="font-weight:normal; color:var(--text-muted); font-size:0.8rem;">於 ${log.timestamp}</span></span>
        <span class="task-badge" style="background: rgba(16, 185, 129, 0.15); color: var(--success); font-weight:600; border:1px solid rgba(16, 185, 129, 0.3); font-size:0.75rem; padding:1px 6px; border-radius:3px;">${log.percent}%</span>
      </div>
      <div style="color:var(--text-muted); white-space:pre-wrap; margin-top:0.25rem;">${log.text}</div>
    `;
    container.appendChild(item);
  });
}

// 更新任務狀態
async function updateTaskStatusFromDetail() {
  if (!currentTaskDetail || !supabaseClient) return;
  const newStatus = document.getElementById('detail-task-status').value;
  
  const { assignees } = parseTaskMetadata(currentTaskDetail);
  if (currentUser.role === 'rd' && !assignees.includes(currentUser.id)) {
    showToast('權限錯誤：您只能修改被指派給您自己的任務狀態。', 'warning');
    document.getElementById('detail-task-status').value = currentTaskDetail.status;
    return;
  }

  const { error } = await supabaseClient.from('tasks').update({ status: newStatus }).eq('id', currentTaskDetail.id);

  if (error) {
    showToast(`狀態更新失敗：${error.message}`, 'danger');
  } else {
    currentTaskDetail.status = newStatus;
    showToast(`任務狀態已變更為 ${newStatus}`, 'success');
    await logActivity(`${currentUser.name} 變更了任務「${currentTaskDetail.title}」的狀態至 [${newStatus}]。`);
    await renderProjectBoard();
  }
}

// 儲存 Bug 詳情
async function saveBugDetailsFromDetail() {
  if (!currentTaskDetail || currentTaskDetail.type !== 'bug' || !supabaseClient) return;

  const steps = document.getElementById('detail-bug-steps-input').value.trim();
  const env = document.getElementById('detail-bug-env-input').value.trim();
  const severity = document.getElementById('detail-bug-severity-val').value;

  const { error } = await supabaseClient.from('tasks').update({
    bug_steps: steps,
    bug_env: env,
    bug_severity: severity
  }).eq('id', currentTaskDetail.id);

  if (error) {
    showToast(`Bug 詳細更新失敗：${error.message}`, 'danger');
  } else {
    showToast('Bug 細節資訊已更新！', 'success');
    await logActivity(`${currentUser.name} 更新了 Bug 任務「${currentTaskDetail.title}」的重現步驟。`);
  }
}

// 儲存 Test 詳情
async function saveTestDetailsFromDetail() {
  if (!currentTaskDetail || currentTaskDetail.type !== 'test' || !supabaseClient) return;

  const cases = document.getElementById('detail-test-cases-input').value.trim();
  const results = document.getElementById('detail-test-results-input').value.trim();

  const { error } = await supabaseClient.from('tasks').update({
    test_cases: cases,
    test_results: results
  }).eq('id', currentTaskDetail.id);

  if (error) {
    showToast(`測試詳細更新失敗：${error.message}`, 'danger');
  } else {
    showToast('測試案例與結果已更新！', 'success');
    await logActivity(`${currentUser.name} 提交了測試任務「${currentTaskDetail.title}」的驗證結果。`);
  }
}

// 儲存目前任務的附件資料 (Base64)
let currentTaskAttachments = {};

// 渲染留言與附件
async function renderComments() {
  if (!supabaseClient) return;
  const list = document.getElementById('detail-comments-list');
  list.innerHTML = '';
  
  const attachmentsList = document.getElementById('detail-attachments-list');
  attachmentsList.innerHTML = '';

  currentTaskAttachments = {};

  const { data: comments } = await supabaseClient
    .from('task_comments')
    .select('*')
    .eq('task_id', currentTaskDetail.id)
    .order('created_at', { ascending: true });

  let hasComments = false;
  let hasAttachments = false;

  if (comments) {
    comments.forEach(c => {
      if (c.text && c.text.startsWith('[file-attachment]')) {
        hasAttachments = true;
        try {
          const fileData = JSON.parse(c.text.substring('[file-attachment]'.length).trim());
          currentTaskAttachments[c.id] = fileData;
          renderAttachmentItem(c.id, fileData, c.sender_name);
        } catch (e) {
          console.error('解析附件失敗:', e);
        }
      } else {
        hasComments = true;
        const tDate = new Date(c.created_at);
        const timeStr = `${tDate.getFullYear()}-${String(tDate.getMonth()+1).padStart(2,'0')}-${String(tDate.getDate()).padStart(2,'0')} ${String(tDate.getHours()).padStart(2,'0')}:${String(tDate.getMinutes()).padStart(2,'0')}`;
        
        const bubble = document.createElement('div');
        bubble.className = 'comment-bubble';
        bubble.innerHTML = `
          <div class="comment-meta">
            <span class="comment-author">${c.sender_name}</span>
            <span>${timeStr}</span>
          </div>
          <div class="comment-text">${c.text}</div>
        `;
        list.appendChild(bubble);
      }
    });
  }

  if (!hasComments) {
    list.innerHTML = '<div style="color:var(--text-muted); font-size:0.8rem; text-align:center; padding: 0.5rem 0;">目前無討論留言。</div>';
  }

  if (!hasAttachments) {
    attachmentsList.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem; text-align:center; padding: 1rem; border: 1px dashed var(--border-color); border-radius: 6px;">目前沒有相關檔案。</div>';
  }

  list.scrollTop = list.scrollHeight;
}

// 渲染單個附件項目
function renderAttachmentItem(commentId, fileData, senderName) {
  const sizeLabel = getFriendlySize(fileData.size);
  const iconSvg = getFileIconSvg(fileData.type);
  const container = document.getElementById('detail-attachments-list');
  
  const item = document.createElement('div');
  item.className = 'attachment-item';
  
  // 主管或上傳者本人可以刪除檔案
  const canDelete = (currentUser.role === 'manager' || currentUser.name === senderName);
  const deleteBtnHtml = canDelete ? `
    <button class="attachment-btn delete" onclick="deleteAttachment('${commentId}', '${fileData.name.replace(/'/g, "\\'")}')" title="刪除檔案">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      </svg>
    </button>
  ` : '';

  item.innerHTML = `
    <div class="attachment-info">
      <div class="attachment-icon">${iconSvg}</div>
      <div class="attachment-details">
        <span class="attachment-name" title="${fileData.name}">${fileData.name}</span>
        <div class="attachment-meta">
          <span>${sizeLabel}</span>
          <span>•</span>
          <span>${senderName} 上傳</span>
        </div>
      </div>
    </div>
    <div class="attachment-actions">
      <button class="attachment-btn download" onclick="downloadAttachment('${commentId}')" title="下載檔案">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
        </svg>
      </button>
      ${deleteBtnHtml}
    </div>
  `;
  container.appendChild(item);
}

// 下載附件
function downloadAttachment(commentId) {
  const fileData = currentTaskAttachments[commentId];
  if (!fileData || !fileData.base64) {
    showToast('檔案資料無效或已損毀。', 'danger');
    return;
  }
  
  const link = document.createElement('a');
  link.href = fileData.base64;
  link.download = fileData.name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast(`開始下載檔案：${fileData.name}`, 'success');
}

// 格式化檔案大小
function getFriendlySize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 獲取檔案對應 SVG 圖示
function getFileIconSvg(type) {
  if (!type) {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  }
  if (type.startsWith('image/')) {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  }
  if (type.includes('pdf')) {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15h3a2 2 0 0 0 0-4H9v4Z"/></svg>`;
  }
  if (type.includes('zip') || type.includes('tar') || type.includes('rar') || type.includes('compressed')) {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
  }
  if (type.includes('text') || type.includes('javascript') || type.includes('html') || type.includes('json') || type.includes('css')) {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
  }
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}

// 拖曳上傳事件處理
function handleDragOver(e) {
  e.preventDefault();
  const zone = document.getElementById('attachment-upload-zone');
  if (zone) zone.classList.add('dragover');
}

function handleFileDrop(e) {
  e.preventDefault();
  const zone = document.getElementById('attachment-upload-zone');
  if (zone) zone.classList.remove('dragover');
  
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    processFileForUpload(files[0]);
  }
}

function handleTaskFileSelect(e) {
  const files = e.target.files;
  if (files && files.length > 0) {
    processFileForUpload(files[0]);
    e.target.value = ''; // 重設 input，允許重複選相同檔案
  }
}

// 處理檔案並進行 Base64 編碼上傳
function processFileForUpload(file) {
  if (!currentTaskDetail) return;
  
  // 限制檔案大小為 3MB
  const maxBytes = 3 * 1024 * 1024;
  if (file.size > maxBytes) {
    showToast('檔案大小超過限制 (最大 3MB)。', 'warning');
    return;
  }

  showToast(`正在讀取檔案「${file.name}」...`, 'info');

  const reader = new FileReader();
  reader.onload = async function(e) {
    const base64Data = e.target.result;
    
    const payload = {
      name: file.name,
      type: file.type,
      size: file.size,
      base64: base64Data
    };

    showToast('正在上傳檔案到雲端...', 'info');

    const { error } = await supabaseClient.from('task_comments').insert({
      task_id: currentTaskDetail.id,
      sender_name: currentUser.name,
      text: '[file-attachment]' + JSON.stringify(payload)
    });

    if (error) {
      showToast(`檔案上傳失敗：${error.message}`, 'danger');
    } else {
      showToast(`檔案「${file.name}」上傳成功！`, 'success');
      await logActivity(`${currentUser.name} 在任務「${currentTaskDetail.title}」中上傳了檔案「${file.name}」。`);
      await renderComments();
    }
  };
  
  reader.onerror = function() {
    showToast('讀取檔案失敗。', 'danger');
  };
  
  reader.readAsDataURL(file);
}

// 刪除附件
async function deleteAttachment(commentId, fileName) {
  if (!supabaseClient) return;
  if (!confirm(`確定要刪除檔案「${fileName}」嗎？此動作將無法復原。`)) return;

  showToast('正在從雲端刪除檔案...', 'info');

  const { error } = await supabaseClient
    .from('task_comments')
    .delete()
    .eq('id', commentId);

  if (error) {
    showToast(`檔案刪除失敗：${error.message}`, 'danger');
  } else {
    showToast(`檔案「${fileName}」已成功刪除。`, 'success');
    if (currentTaskAttachments[commentId]) {
      delete currentTaskAttachments[commentId];
    }
    await logActivity(`${currentUser.name} 在任務「${currentTaskDetail.title}」中刪除了檔案「${fileName}」。`);
    await renderComments();
  }
}

// 傳送留言
async function postTaskComment() {
  if (!supabaseClient) return;
  const input = document.getElementById('comment-new-input');
  const text = input.value.trim();
  if (!text || !currentTaskDetail) return;

  const { error } = await supabaseClient.from('task_comments').insert({
    task_id: currentTaskDetail.id,
    sender_name: currentUser.name,
    text: text
  });

  if (error) {
    showToast(`留言發送失敗：${error.message}`, 'danger');
  } else {
    input.value = '';
    input.style.height = 'auto'; // 重設留言框高度
    await logActivity(`${currentUser.name} 在任務「${currentTaskDetail.title}」中新增了留言：「${text}」`);
    await renderComments();
    showToast('留言已傳送', 'info');
  }
}

// 刪除子任務
async function deleteCurrentTask() {
  if (currentUser.role !== 'manager' || !currentTaskDetail || !supabaseClient) return;
  if (!confirm(`確定要刪除子細目任務「${currentTaskDetail.title}」嗎？此操作不可逆。`)) return;

  const { error } = await supabaseClient.from('tasks').delete().eq('id', currentTaskDetail.id);

  if (error) {
    showToast(`刪除任務失敗：${error.message}`, 'danger');
  } else {
    showToast('任務已成功刪除。', 'success');
    await logActivity(`${currentUser.name} 刪除了任務「${currentTaskDetail.title}」。`);
    closeModal('modal-task-detail');
    await renderProjectBoard();
  }
}

// ==================== 11. RD：撰寫週報與 Blocker 回報 ====================
function initRdReportDropdown() {
  const select = document.getElementById('report-week-select');
  select.innerHTML = '';
  currentWeeks.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.value;
    opt.innerText = w.label;
    opt.selected = w.value === selectedWeekId;
    select.appendChild(opt);
  });
}

let tempReportAttachment = null;

async function loadUserReportByWeek() {
  if (!supabaseClient) return;
  selectedWeekId = document.getElementById('report-week-select').value;
  
  const { data: report } = await supabaseClient
    .from('reports')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('week_id', selectedWeekId)
    .single();

  const progInput = document.getElementById('report-progress');
  const probInput = document.getElementById('report-problems');
  const custInput = document.getElementById('report-custom');

  if (report) {
    progInput.value = report.progress_text;
    probInput.value = report.problems_text;
    
    let customText = report.custom_text || '';
    tempReportAttachment = null;
    if (customText.includes('\n\n[report-attachment]')) {
      const parts = customText.split('\n\n[report-attachment]');
      customText = parts[0];
      try {
        tempReportAttachment = JSON.parse(parts[1]);
      } catch (err) {
        console.error('解析週報附件錯誤:', err);
      }
    }
    custInput.value = customText;
  } else {
    progInput.value = '';
    probInput.value = '無';
    custInput.value = '';
    tempReportAttachment = null;
  }

  renderReportAttachmentDisplay();
}

function renderReportAttachmentDisplay() {
  const container = document.getElementById('report-attachment-display');
  if (!container) return;
  container.innerHTML = '';
  
  if (!tempReportAttachment) {
    container.style.display = 'none';
    return;
  }
  
  container.style.display = 'block';
  const sizeLabel = getFriendlySize(tempReportAttachment.size);
  const iconSvg = getFileIconSvg(tempReportAttachment.type);
  
  const item = document.createElement('div');
  item.className = 'attachment-item';
  item.style.maxWidth = '400px';
  item.innerHTML = `
    <div class="attachment-info">
      <div class="attachment-icon">${iconSvg}</div>
      <div class="attachment-details">
        <span class="attachment-name" title="${tempReportAttachment.name}">${tempReportAttachment.name}</span>
        <span class="attachment-meta">${sizeLabel}</span>
      </div>
    </div>
    <div class="attachment-actions">
      <button type="button" class="attachment-btn download" onclick="downloadTempReportAttachment()" title="下載檔案">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
        </svg>
      </button>
      <button type="button" class="attachment-btn delete" onclick="removeReportAttachment()" title="移除檔案">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>
    </div>
  `;
  container.appendChild(item);
}

function downloadTempReportAttachment() {
  if (!tempReportAttachment || !tempReportAttachment.base64) return;
  const link = document.createElement('a');
  link.href = tempReportAttachment.base64;
  link.download = tempReportAttachment.name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast(`開始下載附件：${tempReportAttachment.name}`, 'success');
}

function removeReportAttachment() {
  if (!confirm('確定要移除此附件嗎？請記得送出週報以儲存變更。')) return;
  tempReportAttachment = null;
  renderReportAttachmentDisplay();
  showToast('已移除附件，請記得送出週報儲存變更。', 'info');
}

function handleReportDragOver(e) {
  e.preventDefault();
  const zone = document.getElementById('report-attachment-upload-zone');
  if (zone) zone.classList.add('dragover');
}

function handleReportFileDrop(e) {
  e.preventDefault();
  const zone = document.getElementById('report-attachment-upload-zone');
  if (zone) zone.classList.remove('dragover');
  
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    processReportFile(files[0]);
  }
}

function handleReportFileSelect(e) {
  const files = e.target.files;
  if (files && files.length > 0) {
    processReportFile(files[0]);
    e.target.value = '';
  }
}

function processReportFile(file) {
  const maxBytes = 3 * 1024 * 1024;
  if (file.size > maxBytes) {
    showToast('檔案大小超過限制 (最大 3MB)。', 'warning');
    return;
  }

  showToast(`正在讀取檔案「${file.name}」...`, 'info');

  const reader = new FileReader();
  reader.onload = function(e) {
    tempReportAttachment = {
      name: file.name,
      type: file.type,
      size: file.size,
      base64: e.target.result
    };
    renderReportAttachmentDisplay();
    showToast(`檔案「${file.name}」已載入，請送出週報完成儲存！`, 'success');
  };
  
  reader.onerror = function() {
    showToast('讀取檔案失敗。', 'danger');
  };
  
  reader.readAsDataURL(file);
}

async function submitWeeklyReport(e) {
  e.preventDefault();
  if (!supabaseClient) return;
  selectedWeekId = document.getElementById('report-week-select').value;

  const progress = document.getElementById('report-progress').value.trim();
  const problems = document.getElementById('report-problems').value.trim();
  const custom = document.getElementById('report-custom').value.trim();

  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  let customTextToSend = custom;
  if (tempReportAttachment) {
    customTextToSend += "\n\n[report-attachment]" + JSON.stringify(tempReportAttachment);
  }

  const { error } = await supabaseClient.from('reports').upsert({
    user_id: currentUser.id,
    week_id: selectedWeekId,
    progress_text: progress,
    problems_text: problems,
    custom_text: customTextToSend,
    timestamp: timeStr
  });

  if (error) {
    showToast(`提交週報失敗：${error.message}`, 'danger');
  } else {
    showToast('本週報告提交成功！', 'success');
    const hasBlocker = problems !== '' && problems !== '無' && !problems.includes('沒有');
    await logActivity(`${currentUser.name} 提交了 ${selectedWeekId} 週報。${hasBlocker ? '⚠️ 報告中標註了 Blockers 阻礙問題！' : ''}`);
  }
}

// ==================== 12. 管理者：審閱團隊週報與問題 ====================
function initReportsReviewDropdown() {
  const select = document.getElementById('review-week-select');
  select.innerHTML = '';
  currentWeeks.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.value;
    opt.innerText = w.label;
    opt.selected = w.value === selectedWeekId;
    select.appendChild(opt);
  });
}

async function renderReportsReview() {
  if (!supabaseClient) return;
  const select = document.getElementById('review-week-select');
  if (select) selectedWeekId = select.value;

  const { data: allProfiles } = await supabaseClient.from('profiles').select('*');
  const rds = allProfiles ? allProfiles.filter(u => u.role === 'rd') : [];
  
  const { data: reports } = await supabaseClient
    .from('reports')
    .select('*')
    .eq('week_id', selectedWeekId);

  const container = document.getElementById('reports-review-container');
  container.innerHTML = '';

  if (rds.length === 0) {
    container.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:2rem;">目前沒有註冊的 RD 成員。</div>';
    return;
  }

  rds.forEach(rd => {
    const report = reports ? reports.find(r => r.user_id === rd.id) : null;
    const card = document.createElement('div');
    card.className = 'report-review-card';
    
    let isBlocker = false;
    if (report && report.problems_text && report.problems_text.trim() !== '' && report.problems_text.trim() !== '無' && !report.problems_text.includes('沒有')) {
      isBlocker = true;
      card.style.borderColor = 'var(--danger)';
      card.style.boxShadow = '0 0 15px var(--danger-glow)';
    }

    let reportContentHtml = '';
    
    if (report) {
      let customText = report.custom_text || '無';
      let attachmentHtml = '';
      
      if (customText.includes('\n\n[report-attachment]')) {
        const parts = customText.split('\n\n[report-attachment]');
        customText = parts[0] || '無';
        try {
          const fileData = JSON.parse(parts[1]);
          const sizeLabel = getFriendlySize(fileData.size);
          const iconSvg = getFileIconSvg(fileData.type);
          attachmentHtml = `
            <div style="margin-top:1rem; border-top: 1px dashed var(--border-color); padding-top: 1rem;">
              <div style="font-weight:600; color:var(--primary); font-size:0.9rem; margin-bottom:0.25rem;">週報附件：</div>
              <div class="attachment-item" style="max-width: 400px; background: rgba(255,255,255,0.02);">
                <div class="attachment-info">
                  <div class="attachment-icon">${iconSvg}</div>
                  <div class="attachment-details">
                    <span class="attachment-name" title="${fileData.name}">${fileData.name}</span>
                    <span class="attachment-meta">${sizeLabel}</span>
                  </div>
                </div>
                <div class="attachment-actions">
                  <button type="button" class="attachment-btn download" onclick="downloadReportFile('${fileData.name.replace(/'/g, "\\'")}', '${fileData.base64}')" title="下載附件">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          `;
        } catch (err) {
          console.error('解析週報附件錯誤:', err);
        }
      }

      reportContentHtml = `
        <div>
          <div style="font-weight:600; color:var(--info); font-size:0.9rem; margin-bottom:0.25rem;">1. 進度與產出：</div>
          <div style="white-space:pre-wrap; font-size:0.95rem; background:rgba(255,255,255,0.01); border:1px solid var(--border-color); padding:0.75rem; border-radius:6px;">${report.progress_text}</div>
        </div>
        <div style="margin-top:1rem;">
          <div style="font-weight:600; color:${isBlocker ? 'var(--danger)' : 'var(--text-muted)'}; font-size:0.9rem; margin-bottom:0.25rem;">2. 遭遇問題 (Blocker)：</div>
          <div class="${isBlocker ? 'blocker-alert' : ''}" style="white-space:pre-wrap; font-size:0.95rem; border:1px solid ${isBlocker ? 'var(--danger)' : 'var(--border-color)'}; padding:0.75rem; border-radius:6px; background:${isBlocker ? 'rgba(239,68,68,0.05)' : 'rgba(255,255,255,0.01)'}">
            ${report.problems_text}
          </div>
        </div>
        <div style="margin-top:1rem;">
          <div style="font-weight:600; color:var(--text-muted); font-size:0.9rem; margin-bottom:0.25rem;">3. 自行補充說明 / 建議：</div>
          <div style="white-space:pre-wrap; font-size:0.95rem; background:rgba(255,255,255,0.01); border:1px solid var(--border-color); padding:0.75rem; border-radius:6px;">${customText}</div>
        </div>
        ${attachmentHtml}
      `;
    } else {
      reportContentHtml = `
        <div style="text-align:center; padding:1.5rem; color:var(--text-muted); font-style:italic;">
          該成員尚未提交本週的進度報告。
        </div>
      `;
    }

    card.innerHTML = `
      <div class="report-review-header">
        <div style="display:flex; align-items:center; gap:0.75rem;">
          <div class="avatar" style="width:36px; height:36px;">${rd.name.charAt(0)}</div>
          <div>
            <div style="font-weight:600; font-size:1.1rem; color:var(--text-main);">${rd.name}</div>
            <div style="font-size:0.75rem; color:var(--text-muted);">${rd.email}</div>
          </div>
        </div>
        <div>
          ${report ? `<span style="font-size:0.8rem; color:var(--text-muted);">提交時間：${report.timestamp}</span>` : '<span style="font-size:0.8rem; color:var(--danger); font-weight:600;">未繳交</span>'}
        </div>
      </div>
      ${reportContentHtml}
    `;

    container.appendChild(card);
  });
}

// ==================== 13. 系統備份下載 (ZIP 格式) ====================
async function exportSystemData(isSilent = false) {
  if (!supabaseClient) return;
  if (typeof JSZip === 'undefined') {
    showToast('JSZip 程式庫未載入，無法執行備份。', 'danger');
    return;
  }
  try {
    if (!isSilent) {
      showToast('正在打包雲端資料庫與附件，請稍候...', 'info');
    } else {
      showToast('【安全防護】正在自動備份目前雲端資料，請稍候...', 'info');
    }
    
    // 批次抓取所有表格內容進行備份
    const profiles = await supabaseClient.from('profiles').select('*');
    const projects = await supabaseClient.from('projects').select('*');
    const project_members = await supabaseClient.from('project_members').select('*');
    const tasks = await supabaseClient.from('tasks').select('*');
    const task_comments = await supabaseClient.from('task_comments').select('*');
    const schedules = await supabaseClient.from('schedules').select('*');
    const reports = await supabaseClient.from('reports').select('*');
    const activities = await supabaseClient.from('activities').select('*');

    const zip = new JSZip();
    const processedTaskComments = [];
    const processedReports = [];

    // 處理任務留言中的附件
    if (task_comments.data) {
      for (let i = 0; i < task_comments.data.length; i++) {
        const comment = { ...task_comments.data[i] };
        if (comment.text && comment.text.startsWith('[file-attachment]')) {
          try {
            const jsonStr = comment.text.substring('[file-attachment]'.length);
            const payload = JSON.parse(jsonStr);
            if (payload.base64) {
              const base64Data = payload.base64;
              const parts = base64Data.split(';base64,');
              const rawBase64 = parts[1] || parts[0];
              const uniquePath = `task_comments/${comment.id || i}_${payload.name}`;
              
              // 寫入壓縮檔
              zip.file(`attachments/${uniquePath}`, rawBase64, { base64: true });
              
              // 在 JSON 中移除 Base64，改為相對路徑
              delete payload.base64;
              payload.path = `attachments/${uniquePath}`;
              comment.text = '[file-attachment]' + JSON.stringify(payload);
            }
          } catch (e) {
            console.error('打包任務附件錯誤:', e);
          }
        }
        processedTaskComments.push(comment);
      }
    }

    // 處理週報中的附件
    if (reports.data) {
      for (let i = 0; i < reports.data.length; i++) {
        const report = { ...reports.data[i] };
        if (report.custom_text && report.custom_text.includes('\n\n[report-attachment]')) {
          try {
            const parts = report.custom_text.split('\n\n[report-attachment]');
            const textPart = parts[0];
            const payload = JSON.parse(parts[1]);
            if (payload.base64) {
              const base64Data = payload.base64;
              const partsB = base64Data.split(';base64,');
              const rawBase64 = partsB[1] || partsB[0];
              const uniquePath = `reports/${report.id || i}_${payload.name}`;
              
              // 寫入壓縮檔
              zip.file(`attachments/${uniquePath}`, rawBase64, { base64: true });
              
              // 在 JSON 中移除 Base64，改為相對路徑
              delete payload.base64;
              payload.path = `attachments/${uniquePath}`;
              report.custom_text = textPart + '\n\n[report-attachment]' + JSON.stringify(payload);
            }
          } catch (e) {
            console.error('打包週報附件錯誤:', e);
          }
        }
        processedReports.push(report);
      }
    }

    const backupData = {
      export_time: new Date().toISOString(),
      profiles: profiles.data,
      projects: projects.data,
      project_members: project_members.data,
      tasks: tasks.data,
      task_comments: processedTaskComments,
      schedules: schedules.data,
      reports: processedReports,
      activities: activities.data
    };

    // 加入詮釋資料 JSON 檔
    zip.file("backup_metadata.json", JSON.stringify(backupData, null, 2));

    // 產生壓縮檔並觸發瀏覽器下載
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.href = URL.createObjectURL(zipBlob);
    
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const prefix = isSilent ? 'auto_safety_backup' : 'rd_sync_backup';
    dlAnchorElem.setAttribute("download", `${prefix}_${dateStr}.zip`);
    dlAnchorElem.click();
    
    if (!isSilent) {
      showToast('雲端資料與附件打包匯出成功為 ZIP！', 'success');
    } else {
      showToast('【安全防護】已為您下載目前雲端的防護備份！', 'success');
    }
  } catch (err) {
    console.error('備份打包失敗:', err);
    showToast(`打包備份失敗：${err.message}`, 'danger');
  }
}

// 匯入 ZIP 備份並還原資料庫
async function importSystemData() {
  if (!supabaseClient) return;
  if (typeof JSZip === 'undefined') {
    showToast('JSZip 程式庫未載入，無法執行還原。', 'danger');
    return;
  }

  const fileInput = document.getElementById('import-file-input');
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    showToast('請先選擇您之前備份的 ZIP 檔案。', 'warning');
    return;
  }

  const file = fileInput.files[0];
  if (!confirm('🚨 警告：此動作將會「刪除目前雲端資料庫中的所有資料」並進行覆蓋還原！\n確認要繼續嗎？（開始前系統將自動下載一份目前最新資料作為安全防護）')) {
    return;
  }

  try {
    // 1. 自動備份當前資料防呆
    await exportSystemData(true);
    
    // 延遲一下讓瀏覽器順利處理下載
    await new Promise(resolve => setTimeout(resolve, 1500));

    showToast('正在讀取備份壓縮檔...', 'info');
    const zip = await JSZip.loadAsync(file);
    const metadataFile = zip.file("backup_metadata.json");
    if (!metadataFile) {
      showToast('無效的備份檔案：找不到 backup_metadata.json', 'danger');
      return;
    }

    const metadataText = await metadataFile.async("string");
    const backupData = JSON.parse(metadataText);

    // 簡單驗證欄位是否存在
    if (!backupData.projects || !backupData.tasks || !backupData.profiles) {
      showToast('備份檔案內容損毀或欄位不完整。', 'danger');
      return;
    }

    showToast('正在解析並還原附件檔案...', 'info');

    // 2. 還原 task_comments 的 Base64
    if (backupData.task_comments) {
      for (const comment of backupData.task_comments) {
        if (comment.text && comment.text.startsWith('[file-attachment]')) {
          try {
            const jsonStr = comment.text.substring('[file-attachment]'.length);
            const payload = JSON.parse(jsonStr);
            if (payload.path) {
              const attachmentFile = zip.file(payload.path);
              if (attachmentFile) {
                // 將 binary 轉回 base64
                const base64Content = await attachmentFile.async("base64");
                payload.base64 = `data:${payload.type};base64,${base64Content}`;
                delete payload.path;
                comment.text = '[file-attachment]' + JSON.stringify(payload);
              }
            }
          } catch (e) {
            console.error('還原留言附件失敗:', e);
          }
        }
      }
    }

    // 3. 還原 reports 的 Base64
    if (backupData.reports) {
      for (const report of backupData.reports) {
        if (report.custom_text && report.custom_text.includes('\n\n[report-attachment]')) {
          try {
            const parts = report.custom_text.split('\n\n[report-attachment]');
            const textPart = parts[0];
            const payload = JSON.parse(parts[1]);
            if (payload.path) {
              const attachmentFile = zip.file(payload.path);
              if (attachmentFile) {
                // 將 binary 轉回 base64
                const base64Content = await attachmentFile.async("base64");
                payload.base64 = `data:${payload.type};base64,${base64Content}`;
                delete payload.path;
                report.custom_text = textPart + '\n\n[report-attachment]' + JSON.stringify(payload);
              }
            }
          } catch (e) {
            console.error('還原週報附件失敗:', e);
          }
        }
      }
    }

    showToast('開始清理雲端資料表...', 'info');
    
    // 清空現有表格 (順序關聯性：comments -> tasks -> project_members -> projects -> schedules -> reports -> activities)
    await supabaseClient.from('task_comments').delete().not('task_id', 'is', null);
    await supabaseClient.from('tasks').delete().not('project_id', 'is', null);
    await supabaseClient.from('project_members').delete().not('project_id', 'is', null);
    await supabaseClient.from('projects').delete().not('id', 'is', null);
    await supabaseClient.from('schedules').delete().not('user_id', 'is', null);
    await supabaseClient.from('reports').delete().not('user_id', 'is', null);
    await supabaseClient.from('activities').delete().not('timestamp', 'is', null);

    showToast('正在寫入帳號 Profile 資料...', 'info');
    if (backupData.profiles && backupData.profiles.length > 0) {
      const { error: pErr } = await supabaseClient.from('profiles').upsert(backupData.profiles);
      if (pErr) throw new Error(`Profiles 還原失敗: ${pErr.message}`);
    }

    showToast('正在寫入專案與成員資料...', 'info');
    if (backupData.projects && backupData.projects.length > 0) {
      const { error: prjErr } = await supabaseClient.from('projects').insert(backupData.projects);
      if (prjErr) throw new Error(`Projects 還原失敗: ${prjErr.message}`);
    }
    if (backupData.project_members && backupData.project_members.length > 0) {
      const { error: memErr } = await supabaseClient.from('project_members').insert(backupData.project_members);
      if (memErr) throw new Error(`Project Members 還原失敗: ${memErr.message}`);
    }

    showToast('正在寫入任務與留言...', 'info');
    if (backupData.tasks && backupData.tasks.length > 0) {
      const { error: tskErr } = await supabaseClient.from('tasks').insert(backupData.tasks);
      if (tskErr) throw new Error(`Tasks 還原失敗: ${tskErr.message}`);
    }
    if (backupData.task_comments && backupData.task_comments.length > 0) {
      const { error: cmtErr } = await supabaseClient.from('task_comments').insert(backupData.task_comments);
      if (cmtErr) throw new Error(`Task Comments 還原失敗: ${cmtErr.message}`);
    }

    showToast('正在寫入行事曆與週報...', 'info');
    if (backupData.schedules && backupData.schedules.length > 0) {
      const { error: schErr } = await supabaseClient.from('schedules').insert(backupData.schedules);
      if (schErr) throw new Error(`Schedules 還原失敗: ${schErr.message}`);
    }
    if (backupData.reports && backupData.reports.length > 0) {
      const { error: repErr } = await supabaseClient.from('reports').insert(backupData.reports);
      if (repErr) throw new Error(`Reports 還原失敗: ${repErr.message}`);
    }
    if (backupData.activities && backupData.activities.length > 0) {
      const { error: actErr } = await supabaseClient.from('activities').insert(backupData.activities);
      if (actErr) throw new Error(`Activities 還原失敗: ${actErr.message}`);
    }

    showToast('🎉 雲端資料庫已還原成功！正在重新載入系統...', 'success');
    
    // 如果有當前使用者，記錄活動日誌
    if (currentUser) {
      await logActivity(`${currentUser.name} 匯入了備份資料，完成系統覆蓋還原。`);
    }
    
    setTimeout(() => {
      window.location.reload();
    }, 2000);

  } catch (err) {
    console.error('還原失敗:', err);
    showToast(`還原失敗：${err.message}`, 'danger');
  }
}

// ==================== 14. 管理者專用：專案與成員進階管理 ====================

// 刪除專案
async function handleDeleteProject() {
  if (currentUser.role !== 'manager' || !currentProject || !supabaseClient) return;
  if (!confirm(`確定要刪除專案「${currentProject.name}」嗎？這將會同步刪除該專案下的所有任務與留言，此動作無法復原！`)) return;

  const { error } = await supabaseClient.from('projects').delete().eq('id', currentProject.id);

  if (error) {
    showToast(`刪除專案失敗：${error.message}`, 'danger');
  } else {
    showToast(`專案「${currentProject.name}」已成功刪除。`, 'success');
    await logActivity(`${currentUser.name} 刪除了專案「${currentProject.name}」及其所有子任務。`);

    currentProject = null;
    await initProjectsDashboard();
  }
}

// 開啟新增 RD Modal
function openAddRdModal() {
  if (currentUser.role !== 'manager') return;
  document.getElementById('modal-add-rd').classList.add('active');
}

// 主管手動新增 RD
async function handleManagerAddRd(e) {
  e.preventDefault();
  if (currentUser.role !== 'manager' || !supabaseClient) return;

  const name = document.getElementById('mgr-add-rd-name').value.trim();
  const email = document.getElementById('mgr-add-rd-email').value.trim();
  const password = document.getElementById('mgr-add-rd-password').value;

  if (password.length < 6) {
    showToast('密碼長度必須大於等於 6 個字元。', 'warning');
    return;
  }

  // 在 Supabase Auth 中建立使用者
  const { data, error } = await supabaseClient.auth.signUp({ email, password });
  
  if (error) {
    showToast(`建立帳號失敗：${error.message}`, 'danger');
    return;
  }

  if (data && data.user) {
    // 寫入 profile 設定檔
    const { error: pError } = await supabaseClient.from('profiles').insert({
      id: data.user.id,
      name: name,
      email: email,
      role: 'rd'
    });

    if (pError) {
      showToast(`建立設定檔失敗：${pError.message}`, 'danger');
    } else {
      showToast(`研發人員「${name}」帳號建立成功！`, 'success');
      await logActivity(`${currentUser.name} 手動新增了 RD 成員「${name}」(${email})。`);
      
      closeModal('modal-add-rd');
      document.getElementById('modal-add-rd').querySelector('form').reset();
      
      await renderManagerDashboard();
    }
  }
}

// 主管手動刪除 RD
async function handleDeleteRd(rdId) {
  if (currentUser.role !== 'manager' || !supabaseClient) return;

  const { data: rdUser } = await supabaseClient.from('profiles').select('*').eq('id', rdId).single();
  if (!rdUser) {
    showToast('找不到該名 RD 成員。', 'danger');
    return;
  }

  if (!confirm(`確定要將 RD 成員「${rdUser.name}」自系統中徹底刪除嗎？\n此動作將會刪除其 Profile 設定檔，並解除任務指派、移除專案成員，此動作無法復原！`)) return;

  // 刪除 profile 行 (資料庫會利用外鍵 ON DELETE CASCADE 自動清理 schedules, reports, project_members)
  const { error } = await supabaseClient.from('profiles').delete().eq('id', rdId);

  if (error) {
    showToast(`刪除失敗：${error.message}`, 'danger');
  } else {
    showToast(`已成功刪除 RD 成員「${rdUser.name}」。`, 'success');
    await logActivity(`${currentUser.name} 將 RD 成員「${rdUser.name}」自系統中徹底刪除。`);
    await renderManagerDashboard();
  }
}

// 全域下載週報附件函數
window.downloadReportFile = function(name, base64) {
  const link = document.createElement('a');
  link.href = base64;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast(`開始下載週報附件：${name}`, 'success');
};

// ==================== 15. 忘記密碼與密碼重設邏輯 ====================

// 開啟忘記密碼申請視窗
function openForgotPasswordModal(e) {
  if (e) e.preventDefault();
  document.getElementById('modal-forgot-password').classList.add('active');
  document.getElementById('forgot-password-email').value = '';
}

// 提交忘記密碼申請 (寄送重設信)
async function submitForgotPassword(e) {
  e.preventDefault();
  if (!supabaseClient) return;

  const emailInput = document.getElementById('forgot-password-email');
  const email = emailInput.value.trim();

  showToast('正在發送密碼重設郵件...', 'info');

  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    // 重設信中的連結點擊後，跳轉回目前網站的所在網址
    redirectTo: window.location.origin + window.location.pathname
  });

  if (error) {
    showToast(`發送失敗：${error.message}`, 'danger');
  } else {
    showToast('密碼重設郵件已成功寄出！請至您的信箱收信。', 'success');
    closeModal('modal-forgot-password');
  }
}

// 提交新密碼重設
async function submitResetPassword(e) {
  e.preventDefault();
  if (!supabaseClient) return;

  const newPasswordInput = document.getElementById('reset-new-password');
  const confirmPasswordInput = document.getElementById('reset-confirm-password');

  const newPassword = newPasswordInput.value;
  const confirmPassword = confirmPasswordInput.value;

  if (newPassword.length < 6) {
    showToast('新密碼長度必須大於等於 6 個字元。', 'warning');
    return;
  }

  if (newPassword !== confirmPassword) {
    showToast('兩次輸入的新密碼不一致，請重新檢查。', 'warning');
    return;
  }

  showToast('正在更新您的密碼...', 'info');

  const { error } = await supabaseClient.auth.updateUser({ password: newPassword });

  if (error) {
    showToast(`密碼重設失敗：${error.message}`, 'danger');
  } else {
    showToast('🎉 密碼重設成功！系統將會為您安全登出，請使用新密碼登入。', 'success');
    
    // 清空欄位
    newPasswordInput.value = '';
    confirmPasswordInput.value = '';
    
    // 關閉 Modal 并強制登出重導
    closeModal('modal-reset-password');
    
    // 延遲一下登出讓使用者看清提示
    setTimeout(async () => {
      await supabaseClient.auth.signOut();
      currentUser = null;
      // 重導向至乾淨的網址 (清除所有的 hash 與 query 參數，例如 ?code=...)
      window.location.href = window.location.origin + window.location.pathname;
    }, 2000);
  }
}

// 綁定全域 window
window.openForgotPasswordModal = openForgotPasswordModal;
window.submitForgotPassword = submitForgotPassword;
window.submitResetPassword = submitResetPassword;
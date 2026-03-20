const state = {
  apps: [],
  alerts: [],
  rules: [],
  pullRecords: [],
  keywordRows: [],
  budgetRows: [],
  asaKeywordRows: [],
  asaStageConfigs: [],
  bitableExportSources: [],
  runtimeSchedule: null,
  operationLogs: [],
  editingAppKey: '',
  ruleTotalCount: 0,
  openAlertTotalCount: 0,
  activeSection: 'section-overview',
  pullPage: 1,
  pullTotalPages: 1,
  pullTotal: 0,
  expandedPullRowKey: '',
  keywordPage: 1,
  keywordTotalPages: 1,
  keywordTotal: 0,
  budgetPage: 1,
  budgetTotalPages: 1,
  budgetTotal: 0,
  asaKeywordPage: 1,
  asaKeywordTotalPages: 1,
  asaKeywordTotal: 0,
  activeBudgetDetail: null,
  activeAsaKeywordDetail: null,
  appFeishuEnabled: false,
  dailyBriefMediaSources: [],
  dailyBriefSelectedMediaSources: []
};

let budgetRecomputePollTimer = null;

const PUSH_METRIC_OPTIONS = [
  { value: 'revenue', label: '收入（revenue）' },
  { value: 'event_count', label: '事件数（event_count）' },
  { value: 'purchase_count', label: '购买数（purchase_count）' }
];

const PULL_METRIC_OPTIONS = [
  { value: 'installs', label: '安装量（installs）' },
  { value: 'clicks', label: '点击量（clicks）' },
  { value: 'total_cost', label: '成本（total_cost）' }
];

const defaultRule = {
  timezone: 'Asia/Shanghai',
  silence_minutes: 30,
  metrics: [
    {
      metric: 'revenue',
      granularity: 'hour',
      window: 'last_1h',
      baseline: 'avg_7d_same_hour',
      up_ratio: 2,
      down_ratio: 0.5,
      min_abs_delta: 50,
      severity: { spike: 'P1', drop: 'P0' },
      drilldown_dims: ['media_source', 'country', 'campaign', 'attribution', 'event_type']
    }
  ]
};

const el = {
  sideNav: document.getElementById('sideNav'),
  navItems: Array.from(document.querySelectorAll('.nav-item[data-target]')),
  sections: Array.from(document.querySelectorAll('.section-panel[id]')),

  refreshAllBtn: document.getElementById('refreshAllBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
  lastUpdated: document.getElementById('lastUpdated'),

  ovApps: document.getElementById('ovApps'),
  ovRules: document.getElementById('ovRules'),
  ovOpenAlerts: document.getElementById('ovOpenAlerts'),
  ovLatestRefresh: document.getElementById('ovLatestRefresh'),
  runtimeScheduleForm: document.getElementById('runtimeScheduleForm'),
  runtimePullTimeInput: document.getElementById('runtimePullTimeInput'),
  runtimePushTimeInput: document.getElementById('runtimePushTimeInput'),
  saveRuntimeScheduleBtn: document.getElementById('saveRuntimeScheduleBtn'),
  runtimeSchedulePullSummary: document.getElementById('runtimeSchedulePullSummary'),
  runtimeSchedulePushSummary: document.getElementById('runtimeSchedulePushSummary'),
  runtimeScheduleStatus: document.getElementById('runtimeScheduleStatus'),
  dailyBriefForm: document.getElementById('dailyBriefForm'),
  dailyBriefDateInput: document.getElementById('dailyBriefDateInput'),
  previewDailyBriefBtn: document.getElementById('previewDailyBriefBtn'),
  sendDailyBriefBtn: document.getElementById('sendDailyBriefBtn'),
  dailyBriefStatus: document.getElementById('dailyBriefStatus'),
  dailyBriefMediaSources: document.getElementById('dailyBriefMediaSources'),
  dailyBriefMediaSourcesEmpty: document.getElementById('dailyBriefMediaSourcesEmpty'),
  dailyBriefMediaSourcesSummary: document.getElementById('dailyBriefMediaSourcesSummary'),
  dailyBriefSelectAllMediaBtn: document.getElementById('dailyBriefSelectAllMediaBtn'),
  dailyBriefClearMediaBtn: document.getElementById('dailyBriefClearMediaBtn'),
  bitableExportReportDateInput: document.getElementById('bitableExportReportDateInput'),
  bitableExportCards: document.getElementById('bitableExportCards'),
  bitableSchedulePrimaryNote: document.getElementById('bitableSchedulePrimaryNote'),

  appForm: document.getElementById('appForm'),
  appSubmitBtn: document.getElementById('appSubmitBtn'),
  appResetBtn: document.getElementById('appResetBtn'),
  appsTableBody: document.getElementById('appsTableBody'),
  generateTokenBtn: document.getElementById('generateTokenBtn'),
  appFeishuEnabled: document.getElementById('appFeishuEnabled'),
  appFeishuCard: document.getElementById('appFeishuCard'),
  appFeishuBody: document.getElementById('appFeishuBody'),
  appFeishuSummary: document.getElementById('appFeishuSummary'),

  ruleForm: document.getElementById('ruleForm'),
  rulesList: document.getElementById('rulesList'),
  buildDslJsonBtn: document.getElementById('buildDslJsonBtn'),
  loadDslFromJsonBtn: document.getElementById('loadDslFromJsonBtn'),

  alertsFilter: document.getElementById('alertsFilter'),
  alertsAppSelect: document.getElementById('alertsAppSelect'),
  alertsTableBody: document.getElementById('alertsTableBody'),

  metricsForm: document.getElementById('metricsForm'),
  metricsAppSelect: document.getElementById('metricsAppSelect'),
  metricsPlatformSelect: document.getElementById('metricsPlatformSelect'),
  metricsSourceSelect: document.getElementById('metricsSourceSelect'),
  metricsMetricSelect: document.getElementById('metricsMetricSelect'),
  metricsEventNameInput: document.getElementById('metricsEventNameInput'),
  metricsCanvas: document.getElementById('metricsCanvas'),
  metricsTooltip: document.getElementById('metricsTooltip'),
  metricsLegend: document.getElementById('metricsLegend'),
  metricsDesc: document.getElementById('metricsDesc'),

  pullRecordsFilter: document.getElementById('pullRecordsFilter'),
  pullRecordsAppSelect: document.getElementById('pullRecordsAppSelect'),
  pullRecordsFromInput: document.getElementById('pullRecordsFromInput'),
  pullRecordsToInput: document.getElementById('pullRecordsToInput'),
  pullRecordsPlatformSelect: document.getElementById('pullRecordsPlatformSelect'),
  pullRecordsMediaSourceInput: document.getElementById('pullRecordsMediaSourceInput'),
  pullRecordsCampaignInput: document.getElementById('pullRecordsCampaignInput'),
  pullRecordsTableBody: document.getElementById('pullRecordsTableBody'),
  pullPrevPageBtn: document.getElementById('pullPrevPageBtn'),
  pullNextPageBtn: document.getElementById('pullNextPageBtn'),
  pullPaginationInfo: document.getElementById('pullPaginationInfo'),
  triggerPullBtn: document.getElementById('triggerPullBtn'),
  pullResultModal: document.getElementById('pullResultModal'),
  pullResultModalBackdrop: document.getElementById('pullResultModalBackdrop'),
  pullResultModalCloseBtn: document.getElementById('pullResultModalCloseBtn'),
  pullResultSummary: document.getElementById('pullResultSummary'),
  pullResultDetail: document.getElementById('pullResultDetail'),

  keywordFilter: document.getElementById('keywordFilter'),
  keywordAppSelect: document.getElementById('keywordAppSelect'),
  keywordPlatformSelect: document.getElementById('keywordPlatformSelect'),
  keywordFromInput: document.getElementById('keywordFromInput'),
  keywordToInput: document.getElementById('keywordToInput'),
  keywordStageSelect: document.getElementById('keywordStageSelect'),
  keywordSearchInput: document.getElementById('keywordSearchInput'),
  keywordsTableBody: document.getElementById('keywordsTableBody'),
  keywordPrevPageBtn: document.getElementById('keywordPrevPageBtn'),
  keywordNextPageBtn: document.getElementById('keywordNextPageBtn'),
  keywordPaginationInfo: document.getElementById('keywordPaginationInfo'),
  keywordRecomputeBtn: document.getElementById('keywordRecomputeBtn'),

  budgetFilter: document.getElementById('budgetFilter'),
  budgetAppSelect: document.getElementById('budgetAppSelect'),
  budgetPlatformSelect: document.getElementById('budgetPlatformSelect'),
  budgetFromInput: document.getElementById('budgetFromInput'),
  budgetToInput: document.getElementById('budgetToInput'),
  budgetStatusSelect: document.getElementById('budgetStatusSelect'),
  budgetTableBody: document.getElementById('budgetTableBody'),
  budgetPrevPageBtn: document.getElementById('budgetPrevPageBtn'),
  budgetNextPageBtn: document.getElementById('budgetNextPageBtn'),
  budgetPaginationInfo: document.getElementById('budgetPaginationInfo'),
  budgetRecomputeBtn: document.getElementById('budgetRecomputeBtn'),
  budgetRecomputeProgress: document.getElementById('budgetRecomputeProgress'),
  budgetRecomputeProgressBar: document.getElementById('budgetRecomputeProgressBar'),
  budgetRecomputeProgressText: document.getElementById('budgetRecomputeProgressText'),
  budgetRecomputeProgressHint: document.getElementById('budgetRecomputeProgressHint'),
  budgetRuleHelpBtn: document.getElementById('budgetRuleHelpBtn'),

  asaStageForm: document.getElementById('asaStageForm'),
  asaStageAppSelect: document.getElementById('asaStageAppSelect'),
  asaStagePlatformSelect: document.getElementById('asaStagePlatformSelect'),
  asaStageStageSelect: document.getElementById('asaStageStageSelect'),
  asaKeywordRecomputeBtn: document.getElementById('asaKeywordRecomputeBtn'),
  asaBriefForm: document.getElementById('asaBriefForm'),
  asaBriefDateInput: document.getElementById('asaBriefDateInput'),
  asaBriefAppSelect: document.getElementById('asaBriefAppSelect'),
  asaBriefPlatformSelect: document.getElementById('asaBriefPlatformSelect'),
  previewAsaBriefBtn: document.getElementById('previewAsaBriefBtn'),
  sendAsaBriefBtn: document.getElementById('sendAsaBriefBtn'),
  asaBriefStatus: document.getElementById('asaBriefStatus'),
  asaKeywordFilter: document.getElementById('asaKeywordFilter'),
  asaKeywordAppSelect: document.getElementById('asaKeywordAppSelect'),
  asaKeywordPlatformSelect: document.getElementById('asaKeywordPlatformSelect'),
  asaKeywordStageSelect: document.getElementById('asaKeywordStageSelect'),
  asaKeywordFromInput: document.getElementById('asaKeywordFromInput'),
  asaKeywordToInput: document.getElementById('asaKeywordToInput'),
  asaKeywordSearchInput: document.getElementById('asaKeywordSearchInput'),
  asaKeywordCampaignInput: document.getElementById('asaKeywordCampaignInput'),
  asaSummaryKeywordCount: document.getElementById('asaSummaryKeywordCount'),
  asaSummaryInstalls: document.getElementById('asaSummaryInstalls'),
  asaSummaryCost: document.getElementById('asaSummaryCost'),
  asaSummaryEcpi: document.getElementById('asaSummaryEcpi'),
  asaSummaryCpp: document.getElementById('asaSummaryCpp'),
  asaSummaryRoas: document.getElementById('asaSummaryRoas'),
  asaKeywordsTableBody: document.getElementById('asaKeywordsTableBody'),
  asaKeywordPrevPageBtn: document.getElementById('asaKeywordPrevPageBtn'),
  asaKeywordNextPageBtn: document.getElementById('asaKeywordNextPageBtn'),
  asaKeywordPaginationInfo: document.getElementById('asaKeywordPaginationInfo'),
  operationLogsFilter: document.getElementById('operationLogsFilter'),
  operationLogsSourceSelect: document.getElementById('operationLogsSourceSelect'),
  operationLogsStatusSelect: document.getElementById('operationLogsStatusSelect'),
  operationLogsLimitSelect: document.getElementById('operationLogsLimitSelect'),
  operationLogsTableBody: document.getElementById('operationLogsTableBody'),

  keywordDrawer: document.getElementById('keywordDrawer'),
  keywordDrawerBackdrop: document.getElementById('keywordDrawerBackdrop'),
  closeKeywordDrawerBtn: document.getElementById('closeKeywordDrawerBtn'),
  keywordDrawerMeta: document.getElementById('keywordDrawerMeta'),
  keywordTrendCanvas: document.getElementById('keywordTrendCanvas'),
  keywordTooltip: document.getElementById('keywordTooltip'),
  keywordTrendLegend: document.getElementById('keywordTrendLegend'),
  keywordTrendRaw: document.getElementById('keywordTrendRaw'),
  asaKeywordDrawer: document.getElementById('asaKeywordDrawer'),
  asaKeywordDrawerBackdrop: document.getElementById('asaKeywordDrawerBackdrop'),
  closeAsaKeywordDrawerBtn: document.getElementById('closeAsaKeywordDrawerBtn'),
  asaKeywordDrawerMeta: document.getElementById('asaKeywordDrawerMeta'),
  asaKeywordTrendCanvas: document.getElementById('asaKeywordTrendCanvas'),
  asaKeywordTooltip: document.getElementById('asaKeywordTooltip'),
  asaKeywordTrendLegend: document.getElementById('asaKeywordTrendLegend'),
  asaKeywordTrendRaw: document.getElementById('asaKeywordTrendRaw'),

  budgetDetailModal: document.getElementById('budgetDetailModal'),
  budgetDetailModalBackdrop: document.getElementById('budgetDetailModalBackdrop'),
  closeBudgetDetailModalBtn: document.getElementById('closeBudgetDetailModalBtn'),
  budgetDetailTitle: document.getElementById('budgetDetailTitle'),
  budgetDetailSummary: document.getElementById('budgetDetailSummary'),
  budgetDetailDisplayName: document.getElementById('budgetDetailDisplayName'),
  budgetDetailMediaSource: document.getElementById('budgetDetailMediaSource'),
  budgetDetailPrimaryMetric: document.getElementById('budgetDetailPrimaryMetric'),
  budgetDetailMetricMode: document.getElementById('budgetDetailMetricMode'),
  budgetDetailTier: document.getElementById('budgetDetailTier'),
  budgetDetailEcpi: document.getElementById('budgetDetailEcpi'),
  budgetDetailTargetEcpi: document.getElementById('budgetDetailTargetEcpi'),
  budgetDetailCurrentRoas: document.getElementById('budgetDetailCurrentRoas'),
  budgetDetailTargetRoas: document.getElementById('budgetDetailTargetRoas'),
  budgetDetailCurrentCost: document.getElementById('budgetDetailCurrentCost'),
  budgetDetailSuggestedBudget: document.getElementById('budgetDetailSuggestedBudget'),
  budgetDetailChangeRatio: document.getElementById('budgetDetailChangeRatio'),
  budgetDetailRisk: document.getElementById('budgetDetailRisk'),
  budgetDetailChecklist: document.getElementById('budgetDetailChecklist'),
  budgetDetailPoints: document.getElementById('budgetDetailPoints'),
  budgetDetailRaw: document.getElementById('budgetDetailRaw'),
  dailyBriefModal: document.getElementById('dailyBriefModal'),
  dailyBriefModalBackdrop: document.getElementById('dailyBriefModalBackdrop'),
  dailyBriefModalCloseBtn: document.getElementById('dailyBriefModalCloseBtn'),
  dailyBriefModalTitle: document.getElementById('dailyBriefModalTitle'),
  dailyBriefMeta: document.getElementById('dailyBriefMeta'),
  dailyBriefHeroTitle: document.getElementById('dailyBriefHeroTitle'),
  dailyBriefRenderBadge: document.getElementById('dailyBriefRenderBadge'),
  dailyBriefSummaryGrid: document.getElementById('dailyBriefSummaryGrid'),
  dailyBriefJudgment: document.getElementById('dailyBriefJudgment'),
  dailyBriefActions: document.getElementById('dailyBriefActions'),
  dailyBriefBody: document.getElementById('dailyBriefBody'),
  dailyBriefRaw: document.getElementById('dailyBriefRaw'),
  asaBriefModal: document.getElementById('asaBriefModal'),
  asaBriefModalBackdrop: document.getElementById('asaBriefModalBackdrop'),
  asaBriefModalCloseBtn: document.getElementById('asaBriefModalCloseBtn'),
  asaBriefModalTitle: document.getElementById('asaBriefModalTitle'),
  asaBriefMeta: document.getElementById('asaBriefMeta'),
  asaBriefSummaryGrid: document.getElementById('asaBriefSummaryGrid'),
  asaBriefJudgment: document.getElementById('asaBriefJudgment'),
  asaBriefActions: document.getElementById('asaBriefActions'),
  asaBriefRaw: document.getElementById('asaBriefRaw'),

  alertDrawer: document.getElementById('alertDrawer'),
  alertDrawerBackdrop: document.getElementById('alertDrawerBackdrop'),
  closeAlertDrawerBtn: document.getElementById('closeAlertDrawerBtn'),
  alertDrawerMeta: document.getElementById('alertDrawerMeta'),
  alertDrawerExplanation: document.getElementById('alertDrawerExplanation'),
  alertContribBody: document.getElementById('alertContribBody'),
  alertContribRaw: document.getElementById('alertContribRaw'),

  toast: document.getElementById('toast')
};

let toastTimer = null;
let scrollTicking = false;
const chartState = new WeakMap();
const helpPopoverGroups = Array.from(document.querySelectorAll('.help-group'));
const helpPopoverMap = new WeakMap();
const activeHelpPopovers = new Set();
const helpPopoverHideTimers = new WeakMap();

function appField(name) {
  const field = el.appForm.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
    throw new Error(`未找到 App 字段: ${name}`);
  }
  return field;
}

function initializeHelpPopovers() {
  helpPopoverGroups.forEach((group) => {
    if (!(group instanceof HTMLElement)) {
      return;
    }
    const popover = group.querySelector('.help-popover-floating');
    if (!(popover instanceof HTMLElement)) {
      return;
    }
    helpPopoverMap.set(group, popover);
    document.body.appendChild(popover);
  });
}

function ruleField(name) {
  const field = el.ruleForm.elements.namedItem(name);
  if (
    !(field instanceof HTMLInputElement) &&
    !(field instanceof HTMLSelectElement) &&
    !(field instanceof HTMLTextAreaElement)
  ) {
    throw new Error(`未找到规则字段: ${name}`);
  }
  return field;
}

function showToast(message, isError = false) {
  if (toastTimer) {
    clearTimeout(toastTimer);
  }

  el.toast.textContent = message;
  el.toast.classList.remove('hidden');
  el.toast.style.borderLeftColor = isError ? 'var(--danger)' : 'var(--accent)';
  el.toast.style.background = isError ? '#fff5f5' : '#f1fbfe';

  toastTimer = setTimeout(() => {
    el.toast.classList.add('hidden');
  }, 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });

  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
    window.location.assign(`/login?next=${next}`);
    throw new Error('unauthorized');
  }
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `request_failed_${res.status}`);
  }
  return body;
}

function fmtTime(v) {
  if (!v) return '-';
  return new Date(v).toLocaleString();
}

function toSqlDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function toSqlDate(date) {
  return date.toISOString().slice(0, 10);
}

function toLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isValidTimeValue(value) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || '').trim());
}

function addMinutesToTimeValue(value, minutes) {
  if (!isValidTimeValue(value)) {
    return '--:--';
  }
  const [hour, minute] = String(value).split(':').map(Number);
  const total = ((hour * 60 + minute + minutes) % (24 * 60) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function statusLabel(status) {
  if (status === 'open') return '未恢复（open）';
  if (status === 'resolved') return '已恢复（resolved）';
  if (status === 'ok') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'skipped') return '已跳过';
  if (status === 'skipped_cycle_locked') return '任务占用，已跳过';
  if (status === 'skipped_recently_pulled') return '刚拉过，已跳过';
  if (status === 'skipped_same_content_cooldown') return '内容未变，进入冷却';
  if (status === 'skipped_rate_limited_after_403') return '命中限流，后续已跳过';
  return status || '-';
}

function metricLabel(metric) {
  if (metric === 'revenue') return '收入（revenue）';
  if (metric === 'event_count') return '事件数（event_count）';
  if (metric === 'purchase_count') return '购买数（purchase_count）';
  if (metric === 'installs') return '安装量（installs）';
  if (metric === 'clicks') return '点击量（clicks）';
  if (metric === 'total_cost') return '成本（total_cost）';
  return metric || '-';
}

function platformLabel(platform) {
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  if (platform === 'unknown') return '未知（unknown）';
  return platform || '-';
}

function primaryMetricLabel(metric) {
  if (metric === 'roas') return 'ROAS（roas）';
  return 'eCPI（ecpi）';
}

function metricModeLabel(mode) {
  if (mode === 'roas_pending_revenue') return 'ROAS 待收入数据（roas_pending_revenue）';
  return '生效中（active）';
}

function asaStageLabel(stage) {
  if (stage === 'stable') return '稳定期';
  if (stage === 'rising') return '上升期';
  return stage || '-';
}

function asaRecommendationStatusLabel(status) {
  const mapping = {
    pending: '待纳入简报',
    sent: '已纳入简报',
    applied: '已执行',
    rejected: '已拒绝',
    expired: '已过期'
  };
  return mapping[status] || status || '-';
}

function asaPrimaryMetricLabel(metric) {
  if (metric === 'd7_roas_cpp') return 'D7 ROAS + CPP';
  return 'eCPI';
}

function matchTypeLabel(matchType) {
  if (matchType === 'unknown') return '未知（unknown）';
  return matchType || '-';
}

function displayNameOfApp(app) {
  const raw = String(app?.display_name || '').trim();
  if (raw) {
    return raw;
  }
  return String(app?.app_key || '').replaceAll('-', ' ').trim();
}

function appConfigOf(appKey) {
  return (state.apps || []).find((item) => item.app_key === appKey) || null;
}

function productViewName(appKey, platform) {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  if (appKey === 'ai-seek') {
    if (normalizedPlatform === 'ios') return 'Novix';
    if (normalizedPlatform === 'android') return 'AI Seek';
  }

  const app = appConfigOf(appKey);
  if (!app) {
    return String(appKey || '').replaceAll('-', ' ').trim();
  }

  if (normalizedPlatform === 'ios' && app.ios_display_name) {
    return String(app.ios_display_name).trim();
  }
  if (normalizedPlatform === 'android' && app.android_display_name) {
    return String(app.android_display_name).trim();
  }
  return displayNameOfApp(app);
}

function lifecycleStageLabel(stage) {
  const mapping = {
    new: '新词',
    learning: '学习期',
    scaling: '放量期',
    stable: '稳定期',
    declining: '衰退期',
    pause_candidate: '暂停候选'
  };
  return mapping[stage] || stage || '-';
}

function actionLabel(action) {
  const mapping = {
    increase: '提高',
    decrease: '降低',
    hold: '保持',
    pause: '暂停'
  };
  return mapping[action] || action || '-';
}

function budgetStatusLabel(status) {
  const mapping = {
    pending: '待处理（pending）',
    applied: '已执行（applied）',
    rejected: '已拒绝（rejected）',
    expired: '已过期（expired）'
  };
  return mapping[status] || status || '-';
}

function volumeTierLabel(tier) {
  const mapping = {
    low: '低量级',
    medium: '中量级',
    high: '高量级'
  };
  return mapping[tier] || tier || '-';
}

function operationStatusLabel(status) {
  const mapping = {
    success: '成功',
    failed: '失败',
    skipped: '跳过',
    info: '信息'
  };
  return mapping[status] || status || '-';
}

function safeJsonParse(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function hasAppLevelFeishuConfig(app) {
  return Boolean(
    String(app?.notify_feishu_app_id || '').trim() ||
      String(app?.notify_feishu_chat_id || '').trim() ||
      String(app?.notify_webhook_url || '').trim() ||
      app?.has_feishu_secret
  );
}

function resolveInitialFeishuEnabled(app) {
  return hasAppLevelFeishuConfig(app);
}

function syncAppFeishuSection() {
  if (!el.appFeishuCard || !el.appFeishuEnabled || !el.appFeishuBody || !el.appFeishuSummary) {
    return;
  }

  el.appFeishuEnabled.checked = state.appFeishuEnabled;
  el.appFeishuCard.classList.toggle('is-open', state.appFeishuEnabled);
  el.appFeishuSummary.textContent = state.appFeishuEnabled
    ? '当前启用应用级 Feishu 配置。未填写的项不会覆盖现有值。'
    : '当前使用全局配置（.env）。如需单独通知到某个机器人或群聊，再手动启用。';

  const inputs = el.appFeishuBody.querySelectorAll('input, textarea, select');
  for (const input of inputs) {
    input.disabled = !state.appFeishuEnabled;
  }
}

function applyUniformFieldLabels() {
  const fields = document.querySelectorAll('label.field, label.filter-field');
  for (const field of fields) {
    const label = field.querySelector('.field-label, span');
    const control = field.querySelector('input, select, textarea');
    if (!(control instanceof HTMLElement) || !(label instanceof HTMLElement)) {
      continue;
    }
    const text = label.textContent?.trim();
    if (!text) {
      continue;
    }
    control.setAttribute('aria-label', text);
  }
}

function setPullResultModalOpen(open) {
  if (open) {
    el.pullResultModal.classList.remove('hidden');
    return;
  }
  el.pullResultModal.classList.add('hidden');
}

function setKeywordDrawerOpen(open) {
  if (open) {
    el.keywordDrawer.classList.add('is-open');
    el.keywordDrawer.setAttribute('aria-hidden', 'false');
    return;
  }
  el.keywordDrawer.classList.remove('is-open');
  el.keywordDrawer.setAttribute('aria-hidden', 'true');
}

function setBudgetDetailModalOpen(open) {
  if (open) {
    el.budgetDetailModal.classList.remove('hidden');
    return;
  }
  el.budgetDetailModal.classList.add('hidden');
}

function setAsaKeywordDrawerOpen(open) {
  if (open) {
    el.asaKeywordDrawer.classList.add('is-open');
    el.asaKeywordDrawer.setAttribute('aria-hidden', 'false');
    return;
  }
  el.asaKeywordDrawer.classList.remove('is-open');
  el.asaKeywordDrawer.setAttribute('aria-hidden', 'true');
}

function setDailyBriefModalOpen(open) {
  if (open) {
    el.dailyBriefModal.classList.remove('hidden');
    requestAnimationFrame(refreshHelpPopoverPositions);
    return;
  }
  el.dailyBriefModal.classList.add('hidden');
  helpPopoverGroups.forEach((group) => hideHelpPopover(group));
}

function getHelpPopover(group) {
  return group instanceof HTMLElement ? helpPopoverMap.get(group) || null : null;
}

function getHelpTrigger(group) {
  if (!(group instanceof HTMLElement)) {
    return null;
  }
  const trigger = group.querySelector('.help-icon');
  return trigger instanceof HTMLElement ? trigger : group;
}

function positionHelpPopover(group) {
  const popover = getHelpPopover(group);
  const trigger = getHelpTrigger(group);
  if (!popover || !trigger) {
    return;
  }

  const minGap = 16;
  const offset = 12;
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const popoverWidth = Math.max(popoverRect.width, 280);
  const popoverHeight = Math.max(popoverRect.height, 120);
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = triggerRect.left + triggerRect.width / 2 - popoverWidth / 2;
  left = Math.max(minGap, Math.min(left, viewportWidth - popoverWidth - minGap));

  const canPlaceBelow = triggerRect.bottom + offset + popoverHeight <= viewportHeight - minGap;
  const canPlaceAbove = triggerRect.top - offset - popoverHeight >= minGap;
  let top = triggerRect.bottom + offset;

  if (!canPlaceBelow && canPlaceAbove) {
    top = triggerRect.top - popoverHeight - offset;
    popover.dataset.placement = 'top';
  } else {
    top = Math.min(top, viewportHeight - popoverHeight - minGap);
    popover.dataset.placement = 'bottom';
  }

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function clearHelpPopoverHideTimer(group) {
  const timer = helpPopoverHideTimers.get(group);
  if (timer) {
    window.clearTimeout(timer);
    helpPopoverHideTimers.delete(group);
  }
}

function showHelpPopover(group) {
  const popover = getHelpPopover(group);
  if (!popover) {
    return;
  }
  clearHelpPopoverHideTimer(group);
  popover.classList.add('is-visible');
  activeHelpPopovers.add(group);
  positionHelpPopover(group);
}

function scheduleHideHelpPopover(group) {
  clearHelpPopoverHideTimer(group);
  const timer = window.setTimeout(() => {
    hideHelpPopover(group);
  }, 90);
  helpPopoverHideTimers.set(group, timer);
}

function hideHelpPopover(group) {
  const popover = getHelpPopover(group);
  if (!popover) {
    return;
  }
  clearHelpPopoverHideTimer(group);
  popover.classList.remove('is-visible');
  popover.dataset.placement = '';
  activeHelpPopovers.delete(group);
}

function refreshHelpPopoverPositions() {
  activeHelpPopovers.forEach((group) => positionHelpPopover(group));
}

function handleHelpFocusOut(group, event) {
  const next = event.relatedTarget;
  const popover = getHelpPopover(group);
  if (next instanceof Node && (group.contains(next) || (popover && popover.contains(next)))) {
    return;
  }
  hideHelpPopover(group);
}

function escapeHtml(raw) {
  return String(raw ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toFixed2(value) {
  return Number(value ?? 0).toFixed(2);
}

function setMetricsMode(source) {
  const isPull = source === 'pull';
  const metricOptions = isPull ? PULL_METRIC_OPTIONS : PUSH_METRIC_OPTIONS;
  const submitBtn = el.metricsForm.querySelector('button[type="submit"]');

  el.metricsMetricSelect.innerHTML = metricOptions
    .map((item) => `<option value="${item.value}">${item.label}</option>`)
    .join('');

  if (isPull) {
    el.metricsEventNameInput.value = 'Pull（每日）下不可用';
    el.metricsEventNameInput.placeholder = '';
    el.metricsEventNameInput.disabled = true;
    el.metricsEventNameInput.setAttribute('aria-disabled-note', 'true');
    el.metricsDesc.textContent = '查看最近 14 天 Pull 日级趋势。';
    if (submitBtn) {
      submitBtn.textContent = '加载最近 14 天';
    }
  } else {
    el.metricsEventNameInput.value = '';
    el.metricsEventNameInput.placeholder = '例如 purchase';
    el.metricsEventNameInput.disabled = false;
    el.metricsEventNameInput.removeAttribute('aria-disabled-note');
    el.metricsDesc.textContent = '查看最近 72 小时趋势。';
    if (submitBtn) {
      submitBtn.textContent = '加载最近 72 小时';
    }
  }
}

function setDrawerOpen(open) {
  if (open) {
    el.alertDrawer.classList.add('is-open');
    el.alertDrawer.setAttribute('aria-hidden', 'false');
  } else {
    el.alertDrawer.classList.remove('is-open');
    el.alertDrawer.setAttribute('aria-hidden', 'true');
  }
}

function parseContributors(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function hideChartTooltip(tooltip) {
  if (!tooltip) return;
  tooltip.classList.add('hidden');
  tooltip.innerHTML = '';
}

function formatChartLabel(raw) {
  if (!raw) return '-';
  if (typeof raw !== 'string') return String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) return raw;
  return raw.includes(':') ? value.toLocaleString() : value.toLocaleDateString();
}

function showChartTooltip(canvas, tooltip, point, row) {
  if (!tooltip || !point || !row) {
    hideChartTooltip(tooltip);
    return;
  }

  const title = escapeHtml(formatChartLabel(row.label ?? row.hour ?? row.date));
  const lines = Array.isArray(row.tooltipLines) ? row.tooltipLines : [`数值：${toFixed2(row.value)}`];
  tooltip.innerHTML = `
    <p class="chart-tooltip-title">${title}</p>
    ${lines.map((line) => `<p class="chart-tooltip-line">${escapeHtml(line)}</p>`).join('')}
  `;
  tooltip.classList.remove('hidden');

  const surface = tooltip.parentElement;
  if (!surface) return;

  const surfaceRect = surface.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const localX = point.x + (canvasRect.left - surfaceRect.left);
  const localY = point.y + (canvasRect.top - surfaceRect.top);

  let left = localX + 14;
  let top = localY - tooltipRect.height - 14;

  if (left + tooltipRect.width > surfaceRect.width - 8) {
    left = localX - tooltipRect.width - 14;
  }
  if (left < 8) {
    left = 8;
  }
  if (top < 8) {
    top = localY + 14;
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function resizeCanvasToDisplaySize(canvas) {
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  const rect = canvas.getBoundingClientRect();
  const displayWidth = Math.max(320, Math.floor(rect.width || canvas.clientWidth || canvas.width || 640));
  const displayHeight = Math.max(180, Math.floor(rect.height || canvas.clientHeight || canvas.height || 260));
  const nextWidth = Math.floor(displayWidth * dpr);
  const nextHeight = Math.floor(displayHeight * dpr);

  if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return {
    ctx,
    width: displayWidth,
    height: displayHeight
  };
}

function findNearestPointIndex(points, mouseX, mouseY) {
  if (!Array.isArray(points) || points.length === 0) {
    return -1;
  }

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    const dx = point.x - mouseX;
    const dy = point.y - mouseY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestDistance <= 24 ? bestIndex : -1;
}

function getCheckedDims() {
  const dims = el.ruleForm.querySelectorAll('input[name="dsl_dim"]:checked');
  return Array.from(dims, (x) => x.value);
}

function setActiveNav(sectionId) {
  state.activeSection = sectionId;
  for (const btn of el.navItems) {
    btn.classList.toggle('is-active', btn.dataset.target === sectionId);
  }
}

function scrollToSection(sectionId, smooth = true) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  setActiveNav(sectionId);
  section.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

function setupSideNav() {
  el.sideNav.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const sectionId = target.dataset.target;
    if (!sectionId) return;
    scrollToSection(sectionId, true);
  });
}

function syncActiveSectionOnScroll() {
  if (scrollTicking) return;
  scrollTicking = true;

  requestAnimationFrame(() => {
    const anchor = window.scrollY + 140;
    let active = el.sections[0]?.id || 'section-overview';

    for (const section of el.sections) {
      if (section.offsetTop <= anchor) {
        active = section.id;
      }
    }

    if (active !== state.activeSection) {
      setActiveNav(active);
    }
    scrollTicking = false;
  });
}

function updateOverviewCards(refreshedAt = new Date()) {
  el.ovApps.textContent = String(state.apps.length);
  el.ovRules.textContent = String(state.ruleTotalCount);
  el.ovOpenAlerts.textContent = String(state.openAlertTotalCount);
  el.ovLatestRefresh.textContent = new Date(refreshedAt).toLocaleTimeString();
}

function buildRuleFromDslForm() {
  const metric = ruleField('dsl_metric').value;
  const metricItem = {
    metric,
    granularity: 'hour',
    window: ruleField('dsl_window').value || 'last_1h',
    baseline: ruleField('dsl_baseline').value || 'avg_7d_same_hour',
    up_ratio: asNumber(ruleField('dsl_up_ratio').value, 2),
    down_ratio: asNumber(ruleField('dsl_down_ratio').value, 0.5),
    min_abs_delta: asNumber(ruleField('dsl_min_abs_delta').value, 50),
    severity: {
      spike: ruleField('dsl_sev_spike').value || 'P1',
      drop: ruleField('dsl_sev_drop').value || 'P0'
    },
    drilldown_dims: getCheckedDims()
  };

  const eventName = (ruleField('dsl_event_name').value || '').trim();
  if (metric === 'event_count' && eventName) {
    metricItem.event_name = eventName;
  }

  return {
    timezone: (ruleField('dsl_timezone').value || 'Asia/Shanghai').trim(),
    silence_minutes: asNumber(ruleField('dsl_silence_minutes').value, 30),
    metrics: [metricItem]
  };
}

function loadDslFormFromRule(ruleJson) {
  const safe = ruleJson && typeof ruleJson === 'object' ? ruleJson : defaultRule;
  const metric = safe.metrics && safe.metrics[0] ? safe.metrics[0] : defaultRule.metrics[0];

  ruleField('dsl_timezone').value = safe.timezone || 'Asia/Shanghai';
  ruleField('dsl_silence_minutes').value = String(safe.silence_minutes ?? 30);
  ruleField('dsl_metric').value = metric.metric || 'revenue';
  ruleField('dsl_event_name').value = metric.event_name || '';
  ruleField('dsl_window').value = metric.window || 'last_1h';
  ruleField('dsl_baseline').value = metric.baseline || 'avg_7d_same_hour';
  ruleField('dsl_up_ratio').value = String(metric.up_ratio ?? 2);
  ruleField('dsl_down_ratio').value = String(metric.down_ratio ?? 0.5);
  ruleField('dsl_min_abs_delta').value = String(metric.min_abs_delta ?? 50);
  ruleField('dsl_sev_spike').value = (metric.severity && metric.severity.spike) || 'P1';
  ruleField('dsl_sev_drop').value = (metric.severity && metric.severity.drop) || 'P0';

  const selected = new Set(metric.drilldown_dims || []);
  const dimBoxes = el.ruleForm.querySelectorAll('input[name="dsl_dim"]');
  for (const box of dimBoxes) {
    box.checked = selected.has(box.value);
  }
}

function populateAppSelects() {
  const options = ['<option value="">全部应用</option>']
    .concat(
      state.apps.map(
        (a) => `<option value="${a.app_key}">${escapeHtml(displayNameOfApp(a))} (${a.app_key})</option>`
      )
    )
    .join('');

  el.alertsAppSelect.innerHTML = options;
  el.pullRecordsAppSelect.innerHTML = options;
  el.keywordAppSelect.innerHTML = options;
  el.budgetAppSelect.innerHTML = options;
  el.asaKeywordAppSelect.innerHTML = options;
  el.asaBriefAppSelect.innerHTML = options;
  el.asaStageAppSelect.innerHTML = options;

  const metricOptions = state.apps
    .map((a) => `<option value="${a.app_key}">${escapeHtml(displayNameOfApp(a))} (${a.app_key})</option>`)
    .join('');
  el.metricsAppSelect.innerHTML = metricOptions;

  if (state.apps[0] && !ruleField('app_key').value) {
    ruleField('app_key').value = state.apps[0].app_key;
  }
  if (state.apps[0] && !el.asaStageAppSelect.value) {
    el.asaStageAppSelect.value = state.apps[0].app_key;
  }
}

function renderApps() {
  el.appsTableBody.innerHTML = state.apps
    .map(
      (app) => `
      <tr>
        <td>${escapeHtml(displayNameOfApp(app))}</td>
        <td>${escapeHtml(app.ios_display_name || '-')}</td>
        <td>${escapeHtml(app.android_display_name || '-')}</td>
        <td class="table-cell-mono">${escapeHtml(app.app_key)}</td>
        <td class="table-cell-mono">${escapeHtml(app.ios_pull_app_id || '-')}</td>
        <td class="table-cell-mono">${escapeHtml(app.android_pull_app_id || '-')}</td>
        <td class="table-cell-mono">${escapeHtml(app.pull_app_id || '-')}</td>
        <td>${escapeHtml(app.dataset)}</td>
        <td>${escapeHtml(app.timezone)}</td>
        <td>${hasAppLevelFeishuConfig(app) ? '应用级配置' : '全局默认（.env）'}</td>
        <td>${fmtTime(app.updated_at)}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-ghost btn-compact" data-edit-app-key="${app.app_key}" type="button">编辑</button>
          </div>
        </td>
      </tr>
    `
    )
    .join('');
}

function resetAppEditor() {
  state.editingAppKey = '';
  el.appForm.reset();
  appField('display_name').value = '';
  appField('ios_display_name').value = '';
  appField('android_display_name').value = '';
  appField('ios_pull_app_id').value = '';
  appField('android_pull_app_id').value = '';
  appField('pull_app_id').value = '';
  appField('dataset').value = 'ods_events_device_detail';
  appField('timezone').value = 'Asia/Shanghai';
  appField('push_auth_token').value = '';
  appField('notify_feishu_app_id').value = '';
  appField('notify_feishu_app_secret').value = '';
  appField('notify_feishu_chat_id').value = '';
  appField('notify_webhook_url').value = '';
  state.appFeishuEnabled = false;
  syncAppFeishuSection();
  el.appSubmitBtn.textContent = '保存应用配置';
}

function applyAppToEditor(app) {
  state.editingAppKey = app.app_key;
  appField('display_name').value = app.display_name || '';
  appField('ios_display_name').value = app.ios_display_name || '';
  appField('android_display_name').value = app.android_display_name || '';
  appField('app_key').value = app.app_key || '';
  appField('ios_pull_app_id').value = app.ios_pull_app_id || '';
  appField('android_pull_app_id').value = app.android_pull_app_id || '';
  appField('pull_app_id').value = app.pull_app_id || '';
  appField('dataset').value = app.dataset || 'ods_events_device_detail';
  appField('timezone').value = app.timezone || 'Asia/Shanghai';
  appField('push_auth_token').value = '';
  appField('notify_feishu_app_id').value = app.notify_feishu_app_id || '';
  appField('notify_feishu_app_secret').value = '';
  appField('notify_feishu_chat_id').value = app.notify_feishu_chat_id || '';
  appField('notify_webhook_url').value = app.notify_webhook_url || '';
  state.appFeishuEnabled = resolveInitialFeishuEnabled(app);
  syncAppFeishuSection();
  el.appSubmitBtn.textContent = `更新应用配置: ${app.app_key}`;
}

function syncAsaStageFormSelection() {
  const appKey = String(el.asaStageAppSelect.value || '').trim();
  const platform = String(el.asaStagePlatformSelect.value || 'ios').trim().toLowerCase();
  if (!appKey || !platform) {
    return;
  }
  const row = (state.asaStageConfigs || []).find((item) => item.app_key === appKey && item.platform === platform);
  el.asaStageStageSelect.value = row?.stage || 'rising';
}

async function loadApps() {
  const body = await api('/api/apps');
  state.apps = body.data || [];
  renderApps();
  populateAppSelects();
  syncAsaStageFormSelection();
}

async function saveAppConfig(event) {
  event.preventDefault();
  const form = new FormData(el.appForm);
  const payload = Object.fromEntries(form.entries());
  const appKey = String(payload.app_key || '').trim();
  const iosPullAppId = String(payload.ios_pull_app_id || '').trim();
  const androidPullAppId = String(payload.android_pull_app_id || '').trim();
  const legacyPullAppId = String(payload.pull_app_id || '').trim();
  if (!iosPullAppId && !androidPullAppId && !legacyPullAppId) {
    throw new Error('请至少填写一个 App ID（iOS / Android / 兼容 App ID）');
  }
  if (!state.appFeishuEnabled) {
    delete payload.notify_feishu_app_id;
    delete payload.notify_feishu_app_secret;
    delete payload.notify_feishu_chat_id;
    delete payload.notify_webhook_url;
  }
  if (!String(payload.notify_feishu_app_secret || '').trim()) {
    delete payload.notify_feishu_app_secret;
  }
  const existed = state.apps.some((app) => app.app_key === appKey);

  await api('/api/apps', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  showToast(existed ? `应用配置已更新: ${appKey}` : `应用配置已创建: ${appKey}`);
  await loadApps();
  const savedApp = state.apps.find((app) => app.app_key === appKey);
  if (savedApp) {
    applyAppToEditor(savedApp);
  } else {
    resetAppEditor();
  }
}

async function handleAppsTableClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  const editAppKey = target.dataset.editAppKey;
  if (!editAppKey) return;

  const app = state.apps.find((item) => item.app_key === editAppKey);
  if (!app) {
    showToast(`未找到应用: ${editAppKey}`, true);
    return;
  }

  applyAppToEditor(app);
  showToast(`正在编辑应用: ${editAppKey}`);
}

function generateToken(bytes = 48) {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  const bin = Array.from(raw, (x) => String.fromCharCode(x)).join('');
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function loadRules(appKey) {
  const query = appKey ? `?appKey=${encodeURIComponent(appKey)}` : '';
  const body = await api(`/api/rules${query}`);
  state.rules = body.data || [];

  el.rulesList.innerHTML = state.rules
    .map(
      (rule) => `
        <div class="rule-row">
          <div class="rule-row-head">
            <strong>${rule.name}</strong>
            <span class="badge ${rule.enabled ? 'badge-P2' : 'badge-P0'}">${rule.enabled ? '已启用' : '已停用'}</span>
          </div>
          <div class="hint">应用=${rule.app_key} · 更新时间=${fmtTime(rule.updated_at)}</div>
          <div class="actions" style="margin-top:8px">
            <button class="btn btn-ghost" data-rule-id="${rule.id}" data-enable="${rule.enabled ? '0' : '1'}" type="button">
              ${rule.enabled ? '停用' : '启用'}
            </button>
            <button class="btn btn-ghost" data-edit-rule-id="${rule.id}" type="button">编辑</button>
          </div>
        </div>
      `
    )
    .join('');
}

function applyRuleToEditor(rule) {
  ruleField('id').value = String(rule.id);
  ruleField('app_key').value = rule.app_key;
  ruleField('name').value = rule.name;
  const json = rule.rule_json || defaultRule;
  ruleField('rule_json').value = JSON.stringify(json, null, 2);
  loadDslFormFromRule(json);
}

async function saveRule(event) {
  event.preventDefault();
  const form = new FormData(el.ruleForm);
  const app_key = String(form.get('app_key') || '').trim();
  const name = String(form.get('name') || '').trim();
  const id = String(form.get('id') || '').trim();

  const rule_json = buildRuleFromDslForm();
  ruleField('rule_json').value = JSON.stringify(rule_json, null, 2);

  await api('/api/rules', {
    method: 'POST',
    body: JSON.stringify({
      id: id ? Number(id) : undefined,
      app_key,
      name,
      enabled: true,
      rule_json
    })
  });

  showToast(id ? '规则已更新' : '规则已创建');
  await loadRules(app_key);
  if (!id) {
    ruleField('id').value = '';
  }
}

async function handleRulesListClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  const ruleId = target.dataset.ruleId;
  if (ruleId) {
    const enable = target.dataset.enable === '1';
    await api(`/api/rules/${ruleId}/${enable ? 'enable' : 'disable'}`, { method: 'POST' });
    showToast(`规则已${enable ? '启用' : '停用'}`);
    await loadRules(ruleField('app_key').value || '');
    return;
  }

  const editRuleId = target.dataset.editRuleId;
  if (editRuleId) {
    const rule = state.rules.find((r) => String(r.id) === String(editRuleId));
    if (!rule) {
      showToast('未找到规则', true);
      return;
    }
    applyRuleToEditor(rule);
    showToast(`正在编辑规则 #${editRuleId}`);
    scrollToSection('section-rules', true);
  }
}

async function loadAlerts(event) {
  if (event) event.preventDefault();
  const form = new FormData(el.alertsFilter);
  const params = new URLSearchParams();
  for (const [key, value] of form.entries()) {
    if (String(value).trim()) params.set(key, String(value));
  }

  const body = await api(`/api/alerts?${params.toString()}`);
  state.alerts = body.data || [];
  el.alertsTableBody.innerHTML = state.alerts
    .map(
      (a) => `
      <tr>
        <td>${fmtTime(a.created_at)}</td>
        <td class="table-cell-mono">${escapeHtml(a.app_key)}</td>
        <td><span class="badge badge-${escapeHtml(a.severity)}">${escapeHtml(a.severity)}</span></td>
        <td><span class="badge badge-${escapeHtml(a.status)}">${escapeHtml(statusLabel(a.status))}</span></td>
        <td>${metricLabel(a.metric)}</td>
        <td>${Number(a.delta_value).toFixed(2)} (${Number(a.delta_ratio).toFixed(2)})</td>
        <td class="table-cell-wrap">${escapeHtml(String(a.explanation || '').slice(0, 80) || '-')}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-ghost btn-compact" data-alert-id="${a.id}" type="button">查看详情</button>
          </div>
        </td>
      </tr>
    `
    )
    .join('');
}

async function openAlertDetail(alertId) {
  const body = await api(`/api/alerts/${alertId}`);
  const alert = body.data;
  const contributors = parseContributors(alert.top_contributors);

  el.alertDrawerMeta.textContent =
    `告警ID=${alert.id} · 应用=${alert.app_key} · 指标=${metricLabel(alert.metric)} · 状态=${statusLabel(alert.status)} · 等级=${alert.severity} · 创建时间=${fmtTime(alert.created_at)}`;
  el.alertDrawerExplanation.textContent = alert.explanation || '-';
  el.alertContribRaw.textContent = JSON.stringify(alert.top_contributors, null, 2);
  el.alertContribBody.innerHTML = contributors
    .map(
      (c) => `
      <tr>
        <td>${c.dim ?? '-'}</td>
        <td>${c.key ?? '-'}</td>
        <td>${Number(c.delta ?? 0).toFixed(2)}</td>
        <td>${Number(c.pct ?? 0).toFixed(4)}</td>
      </tr>
    `
    )
    .join('');

  setDrawerOpen(true);
}

async function handleAlertsTableClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const alertId = target.dataset.alertId;
  if (!alertId) return;
  await openAlertDetail(alertId);
}

function drawLineChart(canvas, rows, options = {}) {
  const resized = resizeCanvasToDisplaySize(canvas);
  if (!resized) return;

  const { ctx, width, height } = resized;
  ctx.clearRect(0, 0, width, height);
  const activeIndex = Number.isInteger(options.activeIndex) ? options.activeIndex : -1;

  const values = rows.map((r) => Number(r.value));
  if (values.length === 0) {
    ctx.fillStyle = '#698198';
    ctx.font = "600 16px 'PingFang SC', 'Noto Sans SC', sans-serif";
    ctx.fillText('暂无数据', 22, 34);
    ctx.fillStyle = '#90a4b8';
    ctx.font = "12px 'JetBrains Mono', 'SFMono-Regular', monospace";
    ctx.fillText('当前筛选条件下没有可绘制的数据点', 22, 56);
    chartState.set(canvas, { rows, points: [], options });
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const left = 52;
  const right = width - 24;
  const top = 20;
  const bottom = height - 36;
  const plotW = right - left;
  const plotH = bottom - top;

  const ticks = 4;
  ctx.strokeStyle = '#e2ebf4';
  ctx.lineWidth = 1;
  for (let i = 0; i <= ticks; i += 1) {
    const y = top + (plotH / ticks) * i;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }

  ctx.strokeStyle = '#cfe1f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottom);
  ctx.lineTo(right, bottom);
  ctx.stroke();

  const points = values.map((v, i) => ({
    x: left + (i / Math.max(values.length - 1, 1)) * plotW,
    y: bottom - ((v - min) / span) * plotH,
    value: v
  }));

  const gradient = ctx.createLinearGradient(0, top, 0, bottom);
  gradient.addColorStop(0, 'rgba(14, 165, 198, 0.20)');
  gradient.addColorStop(1, 'rgba(14, 165, 198, 0.02)');

  ctx.beginPath();
  points.forEach((point, i) => {
    if (i === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.lineTo(points.at(-1)?.x ?? right, bottom);
  ctx.lineTo(points[0]?.x ?? left, bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.strokeStyle = '#0ea5c6';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  points.forEach((point, i) => {
    if (i === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();

  const step = points.length > 24 ? Math.ceil(points.length / 12) : 1;
  points.forEach((point, index) => {
    if (index % step !== 0 && index !== points.length - 1) {
      return;
    }
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0ea5c6';
    ctx.stroke();
  });

  if (activeIndex >= 0 && points[activeIndex]) {
    const activePoint = points[activeIndex];
    ctx.beginPath();
    ctx.arc(activePoint.x, activePoint.y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#0b89a7';
    ctx.stroke();
  }

  ctx.fillStyle = '#4f647d';
  ctx.font = "11px 'JetBrains Mono', 'SFMono-Regular', monospace";
  ctx.fillText(min.toFixed(2), 8, bottom + 4);
  ctx.fillText(max.toFixed(2), 8, top + 4);

  const lastPoint = points.at(-1);
  if (lastPoint) {
    const label = lastPoint.value.toFixed(2);
    const pillWidth = Math.max(54, ctx.measureText(label).width + 16);
    const pillX = Math.min(right - pillWidth, lastPoint.x + 10);
    const pillY = Math.max(top, lastPoint.y - 14);

    ctx.fillStyle = '#0f3e5b';
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillWidth, 24, 10);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = "12px 'JetBrains Mono', 'SFMono-Regular', monospace";
    ctx.fillText(label, pillX + 8, pillY + 16);
  }

  chartState.set(canvas, { rows, points, options });
}

function bindChartHover(canvas, tooltip) {
  if (!canvas || canvas.dataset.hoverBound === 'true') {
    return;
  }
  canvas.dataset.hoverBound = 'true';

  canvas.addEventListener('mousemove', (event) => {
    const stateItem = chartState.get(canvas);
    if (!stateItem?.points?.length) {
      hideChartTooltip(tooltip);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const nextIndex = findNearestPointIndex(stateItem.points, mouseX, mouseY);

    if (nextIndex < 0) {
      drawLineChart(canvas, stateItem.rows, { ...stateItem.options, activeIndex: -1 });
      hideChartTooltip(tooltip);
      return;
    }

    drawLineChart(canvas, stateItem.rows, { ...stateItem.options, activeIndex: nextIndex });
    const refreshed = chartState.get(canvas);
    showChartTooltip(canvas, tooltip, refreshed?.points?.[nextIndex], refreshed?.rows?.[nextIndex]);
  });

  canvas.addEventListener('mouseleave', () => {
    const stateItem = chartState.get(canvas);
    if (stateItem) {
      drawLineChart(canvas, stateItem.rows, { ...stateItem.options, activeIndex: -1 });
    }
    hideChartTooltip(tooltip);
  });
}

function pullRowKey(record, idx) {
  return [state.pullPage, idx, record.app_key, record.platform || 'unknown', record.date, record.ingest_time].join(
    '|'
  );
}

function renderPullRecordsTable() {
  const rows = state.pullRecords || [];
  if (rows.length === 0) {
    el.pullRecordsTableBody.innerHTML =
      '<tr><td class="table-empty" colspan="12">当前筛选条件下暂无 Pull 记录</td></tr>';
    return;
  }

  const html = [];
  rows.forEach((row, idx) => {
    const rowKey = pullRowKey(row, idx);
    const expanded = rowKey === state.expandedPullRowKey;
    const actionText = expanded ? '收起 JSON' : '展开 JSON';

      html.push(`
      <tr>
        <td class="table-cell-mono">${escapeHtml(fmtTime(row.ingest_time))}</td>
        <td>${escapeHtml(row.date)}</td>
        <td>${escapeHtml(productViewName(row.app_key, row.platform || 'unknown'))}</td>
        <td class="table-cell-mono">${escapeHtml(row.app_key)}</td>
        <td>${escapeHtml(platformLabel(row.platform || 'unknown'))}</td>
        <td>${escapeHtml(row.media_source)}</td>
        <td class="table-cell-wrap">${escapeHtml(row.campaign)}</td>
        <td>${toFixed2(row.installs)}</td>
        <td>${toFixed2(row.clicks)}</td>
        <td>${toFixed2(row.total_cost)}</td>
        <td>${escapeHtml(row.source_report)}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-ghost btn-compact" type="button" data-pull-row-key="${escapeHtml(rowKey)}">${actionText}</button>
            <button class="btn btn-ghost btn-compact" type="button" data-pull-delete-key="${escapeHtml(rowKey)}">删除</button>
          </div>
        </td>
      </tr>
    `);

    if (expanded) {
      let pretty = '';
      try {
        pretty = JSON.stringify(JSON.parse(String(row.raw_json || '{}')), null, 2);
      } catch {
        pretty = String(row.raw_json || '{}');
      }
      html.push(`
        <tr class="pull-json-row">
          <td colspan="12">
            <div class="pull-json-wrap">
              <pre class="pull-json-pre">${escapeHtml(pretty)}</pre>
            </div>
          </td>
        </tr>
      `);
    }
  });

  el.pullRecordsTableBody.innerHTML = html.join('');
}

function updatePullPaginationUi() {
  el.pullPaginationInfo.textContent = `第 ${state.pullPage}/${state.pullTotalPages} 页 · 共 ${state.pullTotal} 条`;
  el.pullPrevPageBtn.disabled = state.pullPage <= 1;
  el.pullNextPageBtn.disabled = state.pullPage >= state.pullTotalPages;
}

function renderPullTriggerResult(result) {
  const started = fmtTime(result.started_at);
  const ended = fmtTime(result.ended_at);
  const duration = Number(result.duration_ms || 0);
  const successCount = Number(result.success_count || 0);
  const failedCount = Number(result.failed_count || 0);
  const skippedCount = Number(result.skipped_count || 0);
  const details = Array.isArray(result.details) ? result.details : [];

  el.pullResultSummary.textContent =
    `开始 ${started} · 结束 ${ended} · 耗时 ${duration}ms · 成功 ${successCount} · 失败 ${failedCount} · 跳过 ${skippedCount}`;

  const lines = details.map((item) => {
    const appKey = item.app_key || '-';
    const platform = platformLabel(item.platform || 'unknown');
    const date = item.date || '-';
    const status = item.status ? statusLabel(item.status) : '-';
    const rows = Number(item.rows || 0);
    const metricsRows = Number(item.metrics_rows || 0);
    const error = item.error ? ` · 错误（error）=${item.error}` : '';
    return `应用（app）=${appKey} · 平台（platform）=${platform} · 日期（date）=${date} · 状态（status）=${status} · 记录数（rows）=${rows} · 指标行数（metrics_rows）=${metricsRows}${error}`;
  });
  el.pullResultDetail.textContent = lines.length > 0 ? lines.join('\n') : '无读取明细';
}

function setDefaultPullDateRange() {
  const now = new Date();
  const from = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  el.pullRecordsFromInput.value = toLocalDate(from);
  el.pullRecordsToInput.value = toLocalDate(now);
}

function setDefaultKeywordDateRange() {
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  el.keywordFromInput.value = toLocalDate(from);
  el.keywordToInput.value = toLocalDate(now);
}

function setDefaultBudgetDateRange() {
  const now = new Date();
  const from = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  el.budgetFromInput.value = toLocalDate(from);
  el.budgetToInput.value = toLocalDate(now);
}

function setDefaultDailyBriefDate() {
  const now = new Date();
  const reportDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  el.dailyBriefDateInput.value = toLocalDate(reportDate);
}

function setDefaultBitableExportDate() {
  const now = new Date();
  const reportDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (el.bitableExportReportDateInput) {
    el.bitableExportReportDateInput.value = toLocalDate(reportDate);
  }
}

function getSelectedDailyBriefMediaSources() {
  return Array.from(state.dailyBriefSelectedMediaSources || []);
}

function updateDailyBriefMediaSourceSummary() {
  const total = state.dailyBriefMediaSources.length;
  const selected = getSelectedDailyBriefMediaSources();
  if (total === 0) {
    el.dailyBriefMediaSourcesSummary.textContent = '当前日期暂无可用媒体源。';
    return;
  }
  if (selected.length === 0) {
    el.dailyBriefMediaSourcesSummary.textContent = '当前未选择媒体源，无法预览或发送。';
    return;
  }
  if (selected.length === total) {
    el.dailyBriefMediaSourcesSummary.textContent = `当前已全选 ${total} 个媒体源。`;
    return;
  }
  el.dailyBriefMediaSourcesSummary.textContent = `当前选中 ${selected.length}/${total} 个媒体源：${selected.join('、')}`;
}

function renderDailyBriefMediaSources() {
  const items = state.dailyBriefMediaSources || [];
  el.dailyBriefMediaSourcesEmpty.classList.toggle('hidden', items.length > 0);
  if (items.length === 0) {
    el.dailyBriefMediaSources.innerHTML = '';
    updateDailyBriefMediaSourceSummary();
    return;
  }

  el.dailyBriefMediaSources.innerHTML = items
    .map((item) => {
      const checked = state.dailyBriefSelectedMediaSources.includes(item);
      return `
        <label class="media-chip">
          <input type="checkbox" name="dailyBriefMediaSource" value="${escapeHtml(item)}" ${checked ? 'checked' : ''} />
          <span>${escapeHtml(item)}</span>
        </label>
      `;
    })
    .join('');
  updateDailyBriefMediaSourceSummary();
}

async function loadDailyBriefMediaSources(preserveSelection = false) {
  const reportDate = String(el.dailyBriefDateInput.value || '').trim();
  if (!reportDate) {
    state.dailyBriefMediaSources = [];
    state.dailyBriefSelectedMediaSources = [];
    renderDailyBriefMediaSources();
    return;
  }

  const body = await api(`/api/daily-brief/media-sources?reportDate=${encodeURIComponent(reportDate)}`);
  const items = Array.isArray(body.data) ? body.data.map((item) => String(item || '').trim()).filter(Boolean) : [];
  state.dailyBriefMediaSources = items;
  if (preserveSelection) {
    const selected = new Set(state.dailyBriefSelectedMediaSources.filter((item) => items.includes(item)));
    state.dailyBriefSelectedMediaSources = selected.size > 0 ? Array.from(selected) : [...items];
  } else {
    state.dailyBriefSelectedMediaSources = [...items];
  }
  renderDailyBriefMediaSources();
}

function dailyBriefSummaryItems(summary) {
  return [
    { label: '产品覆盖', value: `${summary.apps_with_data || 0}/${summary.app_count || 0}` },
    { label: '安装', value: toFixed2(summary.total_installs || 0) },
    { label: '点击', value: toFixed2(summary.total_clicks || 0) },
    { label: '成本', value: `$${toFixed2(summary.total_cost || 0)}` },
    { label: '综合 eCPI', value: `$${toFixed2(summary.blended_ecpi || 0)}` },
    { label: '待处理预算', value: String(summary.pending_budget_actions || 0) }
  ];
}

function dailyBriefFilterItems(report) {
  const mediaSources = Array.isArray(report.media_sources_applied) ? report.media_sources_applied : [];
  const filters = report.filters || {};
  return [
    { label: '媒体源', value: mediaSources.length > 0 ? mediaSources.join('、') : '全部' },
    { label: '应用', value: filters.app_key || '全部' },
    { label: '平台', value: filters.platform ? platformLabel(filters.platform) : '全部' }
  ];
}

function renderDailyBriefBody(report) {
  const apps = Array.isArray(report.app_rows) ? report.app_rows : Array.isArray(report.apps) ? report.apps : [];
  const budgets = Array.isArray(report.budget_highlights) ? report.budget_highlights : [];
  const alerts = Array.isArray(report.alert_highlights) ? report.alert_highlights : [];

  const sections = [
    {
      title: '🔎 当前筛选',
      type: 'kv',
      items: dailyBriefFilterItems(report)
    },
    {
      title: '📦 产品概览',
      type: 'card',
      items:
        apps.length > 0
          ? apps.slice(0, 8).map(
              (row) => ({
                title: `${row.display_name || productViewName(row.app_key, row.platform)}（${row.app_key}）`,
                source: Array.isArray(report.media_sources_applied) && report.media_sources_applied.length > 0
                  ? report.media_sources_applied.join('、')
                  : '全部媒体源',
                lines: [
                  `平台 ${platformLabel(row.platform || 'unknown')}`,
                  `安装 ${toFixed2(row.installs)} ｜ 点击 ${toFixed2(row.clicks)}`,
                  `成本 $${toFixed2(row.total_cost)} ｜ eCPI $${toFixed2(row.blended_ecpi)}`
                ]
              })
            )
          : [{ title: '暂无数据', source: '-', lines: ['当前日期暂无 Pull 汇总数据。'] }]
    },
    {
      title: `🎯 预算动作（超过阈值，共 ${budgets.length} 条）`,
      type: 'card',
      items:
        budgets.length > 0
          ? budgets.map(
              (row) => {
                const metricText =
                  row.metric_mode === 'roas_pending_revenue'
                    ? 'ROAS 待收入数据，当前仍按 eCPI 生成建议'
                    : `当前 eCPI $${toFixed2(row.current_ecpi)} ｜ 目标 $${toFixed2(row.target_ecpi)}`;
                return {
                  title: `${actionLabel(row.action)} ${Math.abs((Number(row.change_ratio) || 0) * 100).toFixed(0)}% ｜ ${productViewName(row.app_key, row.platform)}`,
                  source: row.media_source || '-',
                  lines: [
                    `广告系列 ${row.keyword}`,
                    metricText,
                    `理由 ${String(row.reason_summary || '').trim() || '暂无补充说明'}`
                  ]
                };
              }
            )
          : [{ title: '暂无待处理预算动作', source: '-', lines: ['当前没有待处理预算动作。'] }]
    },
    {
      title: '⚠️ 未恢复告警',
      type: 'list',
      items:
        alerts.length > 0
          ? alerts.map(
              (row) =>
                `${productViewName(row.app_key, 'unknown')} / ${row.severity} / ${metricLabel(row.metric)} ｜ Δ ${toFixed2(row.delta_value)} ｜ ${String(row.explanation || '').slice(0, 64) || '-'}`
            )
          : ['当前没有未恢复告警。']
    }
  ];

  el.dailyBriefBody.innerHTML = sections
    .map(
      (section) => `
        <article class="daily-brief-block">
          <h6>${escapeHtml(section.title)}</h6>
          ${
            section.type === 'kv'
              ? `<div class="daily-brief-kv-grid">
                  ${section.items
                    .map(
                      (item) => `<div class="daily-brief-kv-item">
                        <span>${escapeHtml(item.label)}</span>
                        <strong>${escapeHtml(item.value)}</strong>
                      </div>`
                    )
                    .join('')}
                </div>`
              : section.type === 'card'
                ? `<div class="daily-brief-entry-grid">
                    ${section.items
                      .map(
                        (item) => `<article class="daily-brief-entry-card">
                          <div class="daily-brief-entry-head">
                            <strong>${escapeHtml(item.title)}</strong>
                            <span class="daily-brief-source-chip">媒体源 ${escapeHtml(item.source)}</span>
                          </div>
                          <div class="daily-brief-entry-body">
                            ${item.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}
                          </div>
                        </article>`
                      )
                      .join('')}
                  </div>`
                : `<ul class="daily-brief-list">
                    ${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                  </ul>`
          }
        </article>
      `
    )
    .join('');
}

function renderDailyBriefModal(payload, mode) {
  const report = payload?.report || payload || {};
  const summary = report.summary || {};
  const actionItems = Array.isArray(report.action_items) ? report.action_items : [];
  const dispatch = payload?.dispatch || null;
  const notify = payload?.notify || null;
  const skipped = payload?.skipped === true;
  const renderMode = String(notify?.render_mode || report.render_mode || 'interactive');
  const filterItems = dailyBriefFilterItems(report);

  el.dailyBriefModalTitle.textContent = mode === 'send' ? '每日简报发送结果' : '每日简报预览';
  el.dailyBriefMeta.textContent =
    `报告日期 ${report.report_date || '-'} · 产品 ${summary.app_count || 0} 个 · 覆盖 ${summary.apps_with_data || 0} 个 · 安装 ${toFixed2(summary.total_installs || 0)} · 成本 ${toFixed2(summary.total_cost || 0)} · 待处理预算 ${summary.pending_budget_actions || 0} · 建议操作 ${actionItems.length}` +
    (dispatch?.sent_at ? ` · 最近发送 ${fmtTime(dispatch.sent_at)}` : '') +
    (notify?.ok ? ` · Feishu 状态 ${notify.status || 200}` : '') +
    (skipped ? ' · 当日已发送，本次跳过' : '');
  el.dailyBriefHeroTitle.textContent = String(report.title || 'Hotspot 每日简报');
  el.dailyBriefRenderBadge.textContent =
    renderMode === 'text_fallback' ? '文本回退（text_fallback）' : '交互卡片（interactive）';
  el.dailyBriefRenderBadge.className =
    `badge ${renderMode === 'text_fallback' ? 'badge-P1' : 'badge-open'}`;
  el.dailyBriefSummaryGrid.innerHTML = dailyBriefSummaryItems(summary)
    .map(
      (item) => `
        <article class="daily-brief-metric">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </article>
      `
    )
    .join('');
  el.dailyBriefSummaryGrid.insertAdjacentHTML(
    'beforeend',
    `
      <article class="daily-brief-metric daily-brief-metric-wide">
        <span>媒体源</span>
        <strong>${escapeHtml(filterItems[0].value)}</strong>
      </article>
    `
  );
  el.dailyBriefJudgment.textContent = String(report.today_judgment || '暂无判断');
  el.dailyBriefActions.innerHTML = actionItems
    .map(
      (item) => `
        <article class="daily-brief-action-card priority-${escapeHtml(item.priority)}">
          <div class="daily-brief-action-head">
            <span class="badge badge-${escapeHtml(item.priority)}">${escapeHtml(item.priority)}</span>
            <strong>${escapeHtml(item.title)}</strong>
          </div>
          <p>${escapeHtml(item.detail)}</p>
        </article>
      `
    )
    .join('');
  renderDailyBriefBody(report);
  el.dailyBriefRaw.textContent = JSON.stringify(report.feishu_card_payload || {}, null, 2);
  setDailyBriefModalOpen(true);
}

function renderRuntimeSchedule(snapshot) {
  const pullTime = String(snapshot?.pull_time || '09:00').trim();
  const pushTime = String(snapshot?.push_time || '10:00').trim();
  const bitableTime = String(snapshot?.bitable_time || addMinutesToTimeValue(pushTime, 5)).trim();
  const timezone = String(snapshot?.timezone || 'Asia/Shanghai').trim();
  const updatedAt = snapshot?.updated_at ? fmtTime(snapshot.updated_at) : '-';

  if (el.runtimePullTimeInput) {
    el.runtimePullTimeInput.value = isValidTimeValue(pullTime) ? pullTime : '09:00';
  }
  if (el.runtimePushTimeInput) {
    el.runtimePushTimeInput.value = isValidTimeValue(pushTime) ? pushTime : '10:00';
  }

  if (el.runtimeSchedulePullSummary) {
    el.runtimeSchedulePullSummary.textContent = `Puller 与 ASA 数据准备将在 ${pullTime} 开始。`;
  }
  if (el.runtimeSchedulePushSummary) {
    el.runtimeSchedulePushSummary.textContent = `通用日报与 ASA 简报将在 ${pushTime} 发送，多维表格自动顺延至 ${bitableTime}。`;
  }
  if (el.runtimeScheduleStatus) {
    el.runtimeScheduleStatus.textContent = `当前全局调度：Pull ${pullTime} ｜ Push ${pushTime} ｜ 多维表格 ${bitableTime} ｜ 时区 ${timezone} ｜ 最近更新 ${updatedAt}`;
  }
  if (el.bitableSchedulePrimaryNote) {
    el.bitableSchedulePrimaryNote.textContent = `每日 ${bitableTime}（${timezone}）自动执行。Pull 复用当前 Base 中的既有表；ASA Raw 会在同一 Base 下自动创建 / 复用独立表。`;
  }
}

function renderRuntimeSchedulePreview() {
  const pullTime = String(el.runtimePullTimeInput?.value || '09:00').trim() || '09:00';
  const pushTime = String(el.runtimePushTimeInput?.value || '10:00').trim() || '10:00';
  const bitableTime = addMinutesToTimeValue(pushTime, 5);

  if (el.runtimeSchedulePullSummary) {
    el.runtimeSchedulePullSummary.textContent = `Puller 与 ASA 数据准备将在 ${pullTime} 开始。`;
  }
  if (el.runtimeSchedulePushSummary) {
    el.runtimeSchedulePushSummary.textContent = `通用日报与 ASA 简报将在 ${pushTime} 发送，多维表格自动顺延至 ${bitableTime}。`;
  }
  if (el.bitableSchedulePrimaryNote) {
    el.bitableSchedulePrimaryNote.textContent = `每日 ${bitableTime}（Asia/Shanghai）自动执行。Pull 复用当前 Base 中的既有表；ASA Raw 会在同一 Base 下自动创建 / 复用独立表。`;
  }
}

async function loadRuntimeSchedule() {
  const body = await api('/api/runtime-schedule');
  state.runtimeSchedule = body.data || null;
  renderRuntimeSchedule(state.runtimeSchedule);
}

async function saveRuntimeSchedule(event) {
  if (event) {
    event.preventDefault();
  }

  const pullTime = String(el.runtimePullTimeInput?.value || '').trim();
  const pushTime = String(el.runtimePushTimeInput?.value || '').trim();

  if (!isValidTimeValue(pullTime)) {
    throw new Error('请输入有效的 Pull 时间');
  }
  if (!isValidTimeValue(pushTime)) {
    throw new Error('请输入有效的推送时间');
  }

  const originalText = el.saveRuntimeScheduleBtn?.textContent || '保存时间';
  if (el.saveRuntimeScheduleBtn) {
    el.saveRuntimeScheduleBtn.disabled = true;
    el.saveRuntimeScheduleBtn.textContent = '保存中...';
  }

  try {
    const body = await api('/api/runtime-schedule', {
      method: 'POST',
      body: JSON.stringify({ pullTime, pushTime })
    });
    state.runtimeSchedule = body.data || null;
    renderRuntimeSchedule(state.runtimeSchedule);
    showToast(`已更新全局调度：Pull ${pullTime} / Push ${pushTime}`);
  } finally {
    if (el.saveRuntimeScheduleBtn) {
      el.saveRuntimeScheduleBtn.disabled = false;
      el.saveRuntimeScheduleBtn.textContent = originalText;
    }
  }
}

async function previewDailyBrief(event) {
  if (event) {
    event.preventDefault();
  }
  const reportDate = String(el.dailyBriefDateInput.value || '').trim();
  if (!reportDate) {
    throw new Error('请先选择报告日期');
  }
  const selectedMediaSources = getSelectedDailyBriefMediaSources();
  if (state.dailyBriefMediaSources.length > 0 && selectedMediaSources.length === 0) {
    throw new Error('请至少选择一个媒体源');
  }
  const params = new URLSearchParams({ reportDate });
  selectedMediaSources.forEach((item) => params.append('mediaSources', item));
  const body = await api(`/api/daily-brief/preview?${params.toString()}`);
  renderDailyBriefModal(body.data, 'preview');
  el.dailyBriefStatus.textContent = `已生成 ${reportDate} 的日报预览，可直接发送到飞书。`;
}

async function sendDailyBriefOnce() {
  if (el.sendDailyBriefBtn.disabled) {
    return;
  }
  const reportDate = String(el.dailyBriefDateInput.value || '').trim();
  if (!reportDate) {
    throw new Error('请先选择报告日期');
  }
  const selectedMediaSources = getSelectedDailyBriefMediaSources();
  if (state.dailyBriefMediaSources.length > 0 && selectedMediaSources.length === 0) {
    throw new Error('请至少选择一个媒体源');
  }

  const originalText = el.sendDailyBriefBtn.textContent || '发送到飞书';
  el.sendDailyBriefBtn.disabled = true;
  el.sendDailyBriefBtn.textContent = '发送中...';
  try {
    const body = await api('/api/daily-brief/send', {
      method: 'POST',
      body: JSON.stringify({ reportDate, force: true, mediaSources: selectedMediaSources })
    });
    renderDailyBriefModal(body.data, 'send');
    el.dailyBriefStatus.textContent = `日报已发送到飞书群聊：${reportDate}`;
    showToast('每日简报已发送');
  } finally {
    el.sendDailyBriefBtn.disabled = false;
    el.sendDailyBriefBtn.textContent = originalText;
  }
}

function bitableExportStatusLabel(status) {
  const mapping = {
    idle: '未执行',
    success: '成功',
    failed: '失败'
  };
  return mapping[status] || status || '-';
}

function bitableExportStatusBadgeClass(status) {
  if (status === 'success') return 'badge-open';
  if (status === 'failed') return 'badge-P0';
  return 'badge-P2';
}

function renderBitableExportCards() {
  const sources = Array.isArray(state.bitableExportSources) ? state.bitableExportSources : [];
  if (!el.bitableExportCards) {
    return;
  }

  if (sources.length === 0) {
    el.bitableExportCards.innerHTML = '<div class="hint">正在加载多维表格导出配置...</div>';
    return;
  }

  el.bitableExportCards.innerHTML = sources
    .map((source) => {
      const config = source.config || {};
      const selected = Array.isArray(config.selected_fields) ? config.selected_fields : [];
      const targetTableName = String(config.target_table_name || source.label || '-').trim();
      const targetTableId = String(config.target_table_id || '').trim();
      const tableUrl = String(source.table_url || '').trim();
      const lastStatus = String(config.last_status || 'idle');
      const lastError = String(config.last_error || '').trim();
      const chatId = String(config.chat_id || '').trim();
      const isEnabled = config.enabled === true;

      return `
        <article class="bitable-export-card" data-source-type="${escapeHtml(source.source_type)}">
          <div class="bitable-export-card-head">
            <div>
              <h5>${escapeHtml(source.label)}</h5>
              <p>${escapeHtml(source.target_table_hint || '')}</p>
            </div>
            <label class="toggle-switch bitable-toggle">
              <input type="checkbox" data-role="enabled" ${isEnabled ? 'checked' : ''} />
              <span class="toggle-slider" aria-hidden="true"></span>
              <span class="toggle-text">启用自动导出</span>
            </label>
          </div>

          <div class="bitable-export-target">
            <div class="bitable-export-target-main">
              <span class="bitable-export-target-label">目标表</span>
              <strong>${escapeHtml(targetTableName || '-')}</strong>
            </div>
            <div class="bitable-export-target-meta">
              <span class="table-cell-mono">${escapeHtml(targetTableId || '首次执行时自动确认')}</span>
              ${
                tableUrl
                  ? `<a class="btn btn-ghost btn-compact" href="${escapeHtml(tableUrl)}" target="_blank" rel="noreferrer">打开表格</a>`
                  : ''
              }
            </div>
          </div>

          <div class="bitable-export-config-grid">
            <label class="filter-field">
              <span class="field-label">群聊 Chat ID</span>
              <input type="text" data-role="chat-id" value="${escapeHtml(chatId)}" placeholder="oc_xxx / chat_id" />
            </label>
          </div>

          <div class="bitable-export-field-block">
            <div class="bitable-export-field-head">
              <strong>字段列选择</strong>
              <span class="hint">已选 ${selected.length}/${(source.fields || []).length} 列</span>
            </div>
            <div class="bitable-field-grid">
              ${(Array.isArray(source.fields) ? source.fields : [])
                .map(
                  (field) => `
                    <label class="bitable-field-chip">
                      <input
                        type="checkbox"
                        data-role="selected-field"
                        value="${escapeHtml(field.key)}"
                        ${selected.includes(field.key) ? 'checked' : ''}
                      />
                      <span>${escapeHtml(field.label)}</span>
                    </label>
                  `
                )
                .join('')}
            </div>
          </div>

          <div class="bitable-export-status">
            <div class="bitable-export-status-row">
              <span>最近状态</span>
              <strong><span class="badge ${bitableExportStatusBadgeClass(lastStatus)}">${escapeHtml(
                bitableExportStatusLabel(lastStatus)
              )}</span></strong>
            </div>
            <div class="bitable-export-status-row">
              <span>最近同步</span>
              <strong>${escapeHtml(fmtTime(config.last_synced_at))}</strong>
            </div>
            <div class="bitable-export-status-row">
              <span>最近记录数</span>
              <strong>${escapeHtml(String(config.last_record_count || 0))}</strong>
            </div>
            <div class="bitable-export-status-row">
              <span>最近错误</span>
              <strong class="${lastError ? 'bitable-error-text' : ''}">${escapeHtml(lastError || '无')}</strong>
            </div>
          </div>

          <div class="bitable-export-actions">
            <button class="btn btn-secondary" type="button" data-role="save-config">保存配置</button>
            <button class="btn btn-primary" type="button" data-role="run-export">立即导入并推送</button>
          </div>
        </article>
      `;
    })
    .join('');
}

function findBitableExportCard(sourceType) {
  return el.bitableExportCards?.querySelector(`.bitable-export-card[data-source-type="${sourceType}"]`) || null;
}

function collectBitableExportCardPayload(sourceType) {
  const card = findBitableExportCard(sourceType);
  if (!(card instanceof HTMLElement)) {
    throw new Error('未找到对应的数据源卡片');
  }

  const enabledInput = card.querySelector('[data-role="enabled"]');
  const chatIdInput = card.querySelector('[data-role="chat-id"]');
  const selectedFieldInputs = Array.from(card.querySelectorAll('[data-role="selected-field"]:checked'));

  return {
    enabled: enabledInput instanceof HTMLInputElement ? enabledInput.checked : false,
    chatId: chatIdInput instanceof HTMLInputElement ? String(chatIdInput.value || '').trim() : '',
    selectedFields: selectedFieldInputs
      .map((input) => (input instanceof HTMLInputElement ? String(input.value || '').trim() : ''))
      .filter(Boolean)
  };
}

function refreshBitableFieldCount(card) {
  if (!(card instanceof HTMLElement)) {
    return;
  }
  const checked = card.querySelectorAll('[data-role="selected-field"]:checked').length;
  const total = card.querySelectorAll('[data-role="selected-field"]').length;
  const label = card.querySelector('.bitable-export-field-head .hint');
  if (label) {
    label.textContent = `已选 ${checked}/${total} 列`;
  }
}

async function loadBitableExportConfigs() {
  const body = await api('/api/bitable-exports/configs');
  const data = body.data || {};
  state.bitableExportSources = Array.isArray(data.sources) ? data.sources : [];
  renderBitableExportCards();
}

async function saveBitableExportCard(sourceType) {
  const payload = collectBitableExportCardPayload(sourceType);
  const body = await api(`/api/bitable-exports/configs/${encodeURIComponent(sourceType)}`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  const next = body.data || null;
  state.bitableExportSources = (state.bitableExportSources || []).map((item) =>
    item.source_type === sourceType ? next : item
  );
  renderBitableExportCards();
  showToast(`${sourceType === 'pull_daily' ? 'Pull 明细表' : 'ASA Raw 表'} 配置已保存`);
}

async function runBitableExportCard(sourceType) {
  const reportDate = String(el.bitableExportReportDateInput?.value || '').trim();
  if (!reportDate) {
    throw new Error('请先选择手动导出日期');
  }

  const button = findBitableExportCard(sourceType)?.querySelector('[data-role="run-export"]');
  const originalText = button instanceof HTMLButtonElement ? button.textContent || '立即导入并推送' : '';
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
    button.textContent = '导入中...';
  }

  try {
    const body = await api('/api/bitable-exports/run', {
      method: 'POST',
      body: JSON.stringify({ sourceType, reportDate })
    });
    const result = body.data || {};
    await loadBitableExportConfigs();
    await loadOperationLogs();
    showToast(
      `${result.label || (sourceType === 'pull_daily' ? 'Pull 明细表' : 'ASA Raw 表')} 已导入 ${result.record_count || 0} 行`
    );
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function loadPullRecords(event, pageOverride) {
  if (event) {
    event.preventDefault();
  }

  const form = new FormData(el.pullRecordsFilter);
  const appKey = String(form.get('appKey') || '').trim();
  const from = String(form.get('from') || '').trim();
  const to = String(form.get('to') || '').trim();
  const platform = String(form.get('platform') || '').trim().toLowerCase();
  const mediaSource = String(form.get('mediaSource') || '').trim();
  const campaign = String(form.get('campaign') || '').trim();
  const page = Number.isFinite(Number(pageOverride)) ? Number(pageOverride) : state.pullPage || 1;

  if (!from || !to) {
    throw new Error('请先选择起止日期');
  }
  if (from > to) {
    throw new Error('起始日期不能晚于结束日期');
  }

  const params = new URLSearchParams({
    from,
    to,
    page: String(Math.max(1, page)),
    sort: 'ingest_time_desc'
  });
  if (appKey) params.set('appKey', appKey);
  if (platform) params.set('platform', platform);
  if (mediaSource) params.set('mediaSource', mediaSource);
  if (campaign) params.set('campaign', campaign);

  const body = await api(`/api/pull-records?${params.toString()}`);
  state.pullRecords = Array.isArray(body.data) ? body.data : [];
  state.pullPage = Number(body.meta?.page || 1);
  state.pullTotalPages = Number(body.meta?.totalPages || 1);
  state.pullTotal = Number(body.meta?.total || 0);

  if (!state.pullRecords.some((row, idx) => pullRowKey(row, idx) === state.expandedPullRowKey)) {
    state.expandedPullRowKey = '';
  }

  renderPullRecordsTable();
  updatePullPaginationUi();
}

function togglePullRowJson(rowKey) {
  state.expandedPullRowKey = state.expandedPullRowKey === rowKey ? '' : rowKey;
  renderPullRecordsTable();
}

async function deletePullRecord(rowKey) {
  const row = state.pullRecords.find((item, idx) => pullRowKey(item, idx) === rowKey);
  if (!row) {
    throw new Error('未找到对应的 Pull 记录');
  }

  const confirmed = window.confirm(
    `确认删除这条 Pull 记录？\n应用：${row.app_key}\n日期：${row.date}\n媒体源：${row.media_source}\n活动：${row.campaign}`
  );
  if (!confirmed) {
    return;
  }

  await api('/api/pull-records', {
    method: 'DELETE',
    body: JSON.stringify(row)
  });

  if (state.expandedPullRowKey === rowKey) {
    state.expandedPullRowKey = '';
  }

  showToast('Pull 记录已删除');
  await loadPullRecords(undefined, state.pullPage);
}

async function handlePullRecordsTableClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const deleteKey = target.dataset.pullDeleteKey;
  if (deleteKey) {
    await deletePullRecord(deleteKey);
    return;
  }
  const rowKey = target.dataset.pullRowKey;
  if (!rowKey) {
    return;
  }
  togglePullRowJson(rowKey);
}

async function changePullPage(delta) {
  const nextPage = state.pullPage + delta;
  if (nextPage < 1 || nextPage > state.pullTotalPages) {
    return;
  }
  await loadPullRecords(undefined, nextPage);
}

async function triggerPullOnce() {
  if (el.triggerPullBtn.disabled) {
    return;
  }

  const originalText = el.triggerPullBtn.textContent || '手动读取';
  el.triggerPullBtn.disabled = true;
  el.triggerPullBtn.textContent = '读取中...';

  try {
    const body = await api('/api/pull-records/trigger', {
      method: 'POST',
      body: JSON.stringify({ backfillDays: 1 })
    });

    renderPullTriggerResult(body.data || {});
    setPullResultModalOpen(true);
    state.pullPage = 1;
    await loadPullRecords(undefined, 1);
    const result = body.data || {};
    const successCount = Number(result.success_count || 0);
    const failedCount = Number(result.failed_count || 0);
    const skippedCount = Number(result.skipped_count || 0);
    if (successCount > 0 && failedCount === 0 && skippedCount === 0) {
      showToast('手动读取完成');
    } else if (successCount === 0 && failedCount === 0 && skippedCount > 0) {
      showToast('本次未发起实际读取，已命中跳过策略');
    } else if (successCount > 0) {
      showToast('手动读取完成，部分条目已跳过或失败');
    } else {
      showToast('手动读取完成，但全部失败或被跳过', true);
    }
  } finally {
    el.triggerPullBtn.disabled = false;
    el.triggerPullBtn.textContent = originalText;
  }
}

function renderKeywordTable() {
  const rows = state.keywordRows || [];
  if (rows.length === 0) {
    el.keywordsTableBody.innerHTML =
      '<tr><td class="table-empty" colspan="11">当前筛选条件下暂无关键词生命周期数据</td></tr>';
    return;
  }

  el.keywordsTableBody.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(productViewName(row.app_key, row.platform || 'unknown'))}</td>
        <td class="table-cell-mono">${escapeHtml(row.app_key)}</td>
        <td>${escapeHtml(platformLabel(row.platform || 'unknown'))}</td>
        <td class="table-cell-wrap">${escapeHtml(row.keyword)}</td>
        <td>${escapeHtml(matchTypeLabel(row.match_type || 'unknown'))}</td>
        <td><span class="badge badge-stage-${escapeHtml(row.current_stage)}">${lifecycleStageLabel(row.current_stage)}</span></td>
        <td>${toFixed2(row.stage_score)}</td>
        <td>${toFixed2(row.last_installs)}</td>
        <td>${toFixed2(row.last_cpi)}</td>
        <td>${escapeHtml(fmtTime(row.updated_at))}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-ghost btn-compact" type="button" data-keyword-row-id="${row.id}">查看趋势</button>
          </div>
        </td>
      </tr>
    `
    )
    .join('');
}

function updateKeywordPaginationUi() {
  el.keywordPaginationInfo.textContent = `第 ${state.keywordPage}/${state.keywordTotalPages} 页 · 共 ${state.keywordTotal} 条`;
  el.keywordPrevPageBtn.disabled = state.keywordPage <= 1;
  el.keywordNextPageBtn.disabled = state.keywordPage >= state.keywordTotalPages;
}

async function loadKeywordLifecycle(event, pageOverride) {
  if (event) {
    event.preventDefault();
  }

  const form = new FormData(el.keywordFilter);
  const appKey = String(form.get('appKey') || '').trim();
  const platform = String(form.get('platform') || '').trim().toLowerCase();
  const from = String(form.get('from') || '').trim();
  const to = String(form.get('to') || '').trim();
  const stage = String(form.get('stage') || '').trim();
  const keyword = String(form.get('keyword') || '').trim();
  const page = Number.isFinite(Number(pageOverride)) ? Number(pageOverride) : state.keywordPage || 1;
  if (from && to && from > to) {
    throw new Error('关键词查询起始日期不能晚于结束日期');
  }

  const params = new URLSearchParams({
    page: String(Math.max(1, page))
  });
  if (appKey) params.set('appKey', appKey);
  if (platform) params.set('platform', platform);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (stage) params.set('stage', stage);
  if (keyword) params.set('keyword', keyword);

  const body = await api(`/api/keywords/lifecycle?${params.toString()}`);
  state.keywordRows = Array.isArray(body.data) ? body.data : [];
  state.keywordPage = Number(body.meta?.page || 1);
  state.keywordTotalPages = Number(body.meta?.totalPages || 1);
  state.keywordTotal = Number(body.meta?.total || 0);

  renderKeywordTable();
  updateKeywordPaginationUi();
}

async function changeKeywordPage(delta) {
  const next = state.keywordPage + delta;
  if (next < 1 || next > state.keywordTotalPages) {
    return;
  }
  await loadKeywordLifecycle(undefined, next);
}

async function openKeywordTrend(row) {
  const params = new URLSearchParams({
    appKey: row.app_key,
    platform: String(row.platform || 'unknown').toLowerCase(),
    days: '30'
  });
  if (row.match_type) params.set('matchType', row.match_type);
  const body = await api(`/api/keywords/${encodeURIComponent(row.keyword)}/trend?${params.toString()}`);
  const trendRows = Array.isArray(body.data) ? body.data : [];
  const chartRows = trendRows.map((item) => ({
    label: item.date,
    value: Number(item.installs || 0),
    tooltipLines: [
      `安装：${toFixed2(item.installs)}`,
      `CPI：${toFixed2(item.cpi)}`,
      `官方 eCPI：${toFixed2(item.official_ecpi)}`
    ]
  }));
  drawLineChart(el.keywordTrendCanvas, chartRows);

  el.keywordDrawerMeta.textContent =
    `产品视图=${productViewName(row.app_key, row.platform || 'unknown')} · 应用=${row.app_key} · 平台（platform）=${platformLabel(row.platform || 'unknown')} · 关键词（keyword）=${row.keyword} · 匹配类型（match_type）=${matchTypeLabel(row.match_type || 'unknown')} · 阶段（stage）=${lifecycleStageLabel(row.current_stage)} · 阶段天数（days_in_stage）=${row.days_in_stage}`;
  const last = trendRows.at(-1);
  el.keywordTrendLegend.textContent = `数据点=${trendRows.length} · 最新安装量（installs）=${toFixed2(last?.installs)} · 最新 CPI（cpi）=${toFixed2(last?.cpi)}`;
  el.keywordTrendRaw.textContent = JSON.stringify(trendRows, null, 2);
  setKeywordDrawerOpen(true);
}

async function handleKeywordTableClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const rowId = Number(target.dataset.keywordRowId || 0);
  if (!rowId) return;
  const row = state.keywordRows.find((item) => Number(item.id) === rowId);
  if (!row) return;
  await openKeywordTrend(row);
}

async function triggerKeywordRecompute() {
  if (el.keywordRecomputeBtn.disabled) return;
  const originalText = el.keywordRecomputeBtn.textContent || '手动重算';
  el.keywordRecomputeBtn.disabled = true;
  el.keywordRecomputeBtn.textContent = '重算中...';
  try {
    const body = await api('/api/keywords/recompute', {
      method: 'POST',
      body: JSON.stringify({ backfillDays: 30 })
    });
    const result = body.data || {};
    showToast(`关键词重算完成：成功 ${result.success_count || 0} / 失败 ${result.failed_count || 0}`);
    state.keywordPage = 1;
    await loadKeywordLifecycle(undefined, 1);
  } finally {
    el.keywordRecomputeBtn.disabled = false;
    el.keywordRecomputeBtn.textContent = originalText;
  }
}

function renderBudgetTable() {
  const rows = state.budgetRows || [];
  if (rows.length === 0) {
    el.budgetTableBody.innerHTML =
      '<tr><td class="table-empty" colspan="15">当前筛选条件下暂无预算建议</td></tr>';
    return;
  }

  el.budgetTableBody.innerHTML = rows
    .map((row) => {
      const canOperate = row.status === 'pending';
      return `
      <tr>
        <td>${escapeHtml(row.date)}</td>
        <td>${escapeHtml(productViewName(row.app_key, row.platform || 'unknown'))}</td>
        <td class="table-cell-mono">${escapeHtml(row.app_key)}</td>
        <td>${escapeHtml(platformLabel(row.platform || 'unknown'))}</td>
        <td>${escapeHtml(row.media_source || '-')}</td>
        <td class="table-cell-wrap">${escapeHtml(row.keyword)}</td>
        <td>${escapeHtml(primaryMetricLabel(row.primary_metric || 'ecpi'))}</td>
        <td>${escapeHtml(volumeTierLabel(row.volume_tier))}</td>
        <td class="table-cell-tight">${toFixed2(row.current_ecpi)}</td>
        <td class="table-cell-tight">${toFixed2(row.target_ecpi)}</td>
        <td><span class="badge badge-action-${escapeHtml(row.action)}">${actionLabel(row.action)}</span></td>
        <td>${(Number(row.change_ratio || 0) * 100).toFixed(1)}%</td>
        <td>${(Number(row.confidence || 0) * 100).toFixed(1)}%</td>
        <td><span class="badge badge-${escapeHtml(row.status)}">${budgetStatusLabel(row.status)}</span></td>
        <td>
          <div class="table-actions">
            <button class="btn btn-ghost btn-compact" type="button" data-budget-view-id="${row.id}">详情</button>
            ${canOperate ? `<button class="btn btn-ghost btn-compact" type="button" data-budget-apply-id="${row.id}">标记执行</button>` : ''}
            ${canOperate ? `<button class="btn btn-ghost btn-compact" type="button" data-budget-reject-id="${row.id}">拒绝</button>` : ''}
          </div>
        </td>
      </tr>
    `;
    })
    .join('');
}

function updateBudgetPaginationUi() {
  el.budgetPaginationInfo.textContent = `第 ${state.budgetPage}/${state.budgetTotalPages} 页 · 共 ${state.budgetTotal} 条`;
  el.budgetPrevPageBtn.disabled = state.budgetPage <= 1;
  el.budgetNextPageBtn.disabled = state.budgetPage >= state.budgetTotalPages;
}

async function loadBudgetRecommendations(event, pageOverride) {
  if (event) {
    event.preventDefault();
  }
  const form = new FormData(el.budgetFilter);
  const appKey = String(form.get('appKey') || '').trim();
  const platform = String(form.get('platform') || '').trim().toLowerCase();
  const from = String(form.get('from') || '').trim();
  const to = String(form.get('to') || '').trim();
  const status = String(form.get('status') || '').trim();
  const page = Number.isFinite(Number(pageOverride)) ? Number(pageOverride) : state.budgetPage || 1;
  if (from && to && from > to) {
    throw new Error('预算查询起始日期不能晚于结束日期');
  }

  const params = new URLSearchParams({
    page: String(Math.max(1, page))
  });
  if (appKey) params.set('appKey', appKey);
  if (platform) params.set('platform', platform);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (status) params.set('status', status);

  const body = await api(`/api/budget/recommendations?${params.toString()}`);
  state.budgetRows = Array.isArray(body.data) ? body.data : [];
  state.budgetPage = Number(body.meta?.page || 1);
  state.budgetTotalPages = Number(body.meta?.totalPages || 1);
  state.budgetTotal = Number(body.meta?.total || 0);

  renderBudgetTable();
  updateBudgetPaginationUi();
}

async function changeBudgetPage(delta) {
  const next = state.budgetPage + delta;
  if (next < 1 || next > state.budgetTotalPages) {
    return;
  }
  await loadBudgetRecommendations(undefined, next);
}

function openBudgetDetail(row) {
  state.activeBudgetDetail = row;
  const llmSummary = safeJsonParse(row.llm_summary, {});
  const checklist = Array.isArray(llmSummary.checklist) ? llmSummary.checklist : [];
  const points = Array.isArray(llmSummary.explanation_points) ? llmSummary.explanation_points : [];

  el.budgetDetailTitle.textContent = `预算建议详情 · ${productViewName(row.app_key, row.platform || 'unknown')} · ${row.keyword}`;
  el.budgetDetailSummary.textContent = String(llmSummary.summary_cn || `reason_code=${row.reason_code}`);
  el.budgetDetailDisplayName.textContent = productViewName(row.app_key, row.platform || 'unknown');
  el.budgetDetailMediaSource.textContent = String(row.media_source || '-');
  el.budgetDetailPrimaryMetric.textContent = primaryMetricLabel(row.primary_metric || 'ecpi');
  el.budgetDetailMetricMode.textContent = metricModeLabel(row.metric_mode || 'active');
  el.budgetDetailTier.textContent = volumeTierLabel(row.volume_tier);
  el.budgetDetailEcpi.textContent = toFixed2(row.current_ecpi);
  el.budgetDetailTargetEcpi.textContent = toFixed2(row.target_ecpi);
  el.budgetDetailCurrentRoas.textContent = row.current_roas == null ? '-' : toFixed2(row.current_roas);
  el.budgetDetailTargetRoas.textContent = row.target_roas == null ? '-' : toFixed2(row.target_roas);
  el.budgetDetailCurrentCost.textContent = toFixed2(row.current_cost);
  el.budgetDetailSuggestedBudget.textContent = toFixed2(row.suggested_budget);
  el.budgetDetailChangeRatio.textContent = `${(Number(row.change_ratio || 0) * 100).toFixed(1)}%`;
  el.budgetDetailRisk.textContent = String(llmSummary.risk_level || '-');
  el.budgetDetailChecklist.innerHTML = checklist.map((item) => `<li>${escapeHtml(String(item))}</li>`).join('');
  el.budgetDetailPoints.innerHTML = points.map((item) => `<li>${escapeHtml(String(item))}</li>`).join('');
  el.budgetDetailRaw.textContent = JSON.stringify(llmSummary, null, 2);
  setBudgetDetailModalOpen(true);
}

async function updateBudgetStatus(id, mode) {
  const endpoint =
    mode === 'apply'
      ? `/api/budget/recommendations/${id}/mark-applied`
      : `/api/budget/recommendations/${id}/reject`;
  await api(endpoint, { method: 'POST' });
  showToast(mode === 'apply' ? '预算建议已标记为已执行' : '预算建议已拒绝');
  await loadBudgetRecommendations(undefined, state.budgetPage);
}

async function handleBudgetTableClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const viewId = Number(target.dataset.budgetViewId || 0);
  const applyId = Number(target.dataset.budgetApplyId || 0);
  const rejectId = Number(target.dataset.budgetRejectId || 0);

  if (viewId) {
    const row = state.budgetRows.find((item) => Number(item.id) === viewId);
    if (row) {
      openBudgetDetail(row);
    }
    return;
  }
  if (applyId) {
    await updateBudgetStatus(applyId, 'apply');
    return;
  }
  if (rejectId) {
    await updateBudgetStatus(rejectId, 'reject');
  }
}

async function triggerBudgetRecompute() {
  if (el.budgetRecomputeBtn.disabled) return;
  const originalText = el.budgetRecomputeBtn.textContent || '生成建议';
  el.budgetRecomputeBtn.disabled = true;
  el.budgetRecomputeBtn.textContent = '生成中...';
  try {
    renderBudgetRecomputeProgress({
      running: true,
      generated_total: 0,
      total_candidates: 0,
      total_apps: state.apps.length,
      processed_apps: 0,
      current_app: ''
    });
    pollBudgetRecomputeStatus().catch((err) => showToast(err.message || '预算建议进度加载失败', true));
    const body = await api('/api/budget/recommendations/recompute', {
      method: 'POST',
      body: JSON.stringify({})
    });
    const result = body.data || {};
    stopBudgetRecomputePolling();
    await loadBudgetRecomputeStatus().catch(() => null);
    showToast(`预算建议生成完成：新增 ${result.generated_total || 0} 条`);
    state.budgetPage = 1;
    await loadBudgetRecommendations(undefined, 1);
  } catch (error) {
    stopBudgetRecomputePolling();
    await loadBudgetRecomputeStatus().catch(() => null);
    throw error;
  } finally {
    el.budgetRecomputeBtn.disabled = false;
    el.budgetRecomputeBtn.textContent = originalText;
  }
}

function updateAsaSummary(summary = {}) {
  const totalCost = Number(summary.total_cost || 0);
  const installs = Number(summary.installs || 0);
  const revenueD7 = Number(summary.revenue_d7 || 0);
  el.asaSummaryKeywordCount.textContent = String(summary.keyword_count || 0);
  el.asaSummaryInstalls.textContent = toFixed2(summary.installs || 0);
  el.asaSummaryCost.textContent = `$${toFixed2(summary.total_cost || 0)}`;
  el.asaSummaryEcpi.textContent = totalCost > 0 && installs <= 0 ? '—' : `$${toFixed2(summary.ecpi || 0)}`;
  el.asaSummaryCpp.textContent = Number(summary.cpp || 0) > 0 ? `$${toFixed2(summary.cpp || 0)}` : '-';
  el.asaSummaryRoas.textContent = totalCost > 0 ? `${toFixed2(summary.d7_roas || 0)}x` : '-';
  el.asaSummaryRoas.title = totalCost > 0 && revenueD7 <= 0 ? '当前未观察到 D7 收入' : '';
  el.asaSummaryEcpi.title = totalCost > 0 && installs <= 0 ? '当前有花费但没有安装，eCPI 不可计算' : '';
}

function stopBudgetRecomputePolling() {
  if (budgetRecomputePollTimer) {
    clearTimeout(budgetRecomputePollTimer);
    budgetRecomputePollTimer = null;
  }
}

function renderBudgetRecomputeProgress(progress = {}) {
  if (
    !el.budgetRecomputeProgress ||
    !el.budgetRecomputeProgressBar ||
    !el.budgetRecomputeProgressText ||
    !el.budgetRecomputeProgressHint
  ) {
    return;
  }

  const running = Boolean(progress.running);
  const generated = Number(progress.generated_total || 0);
  const total = Number(progress.total_candidates || 0);
  const processedApps = Number(progress.processed_apps || 0);
  const totalApps = Number(progress.total_apps || 0);
  const currentApp = String(progress.current_app || '').trim();
  const error = String(progress.error || '').trim();
  if (el.budgetRecomputeBtn) {
    el.budgetRecomputeBtn.disabled = running;
    el.budgetRecomputeBtn.textContent = running ? '生成中...' : '生成建议';
  }

  if (!running && !error && total <= 0 && generated <= 0) {
    el.budgetRecomputeProgress.classList.add('hidden');
    el.budgetRecomputeProgressBar.style.width = '0%';
    el.budgetRecomputeProgressBar.classList.remove('is-indeterminate');
    return;
  }

  el.budgetRecomputeProgress.classList.remove('hidden');
  const width = total > 0 ? Math.min(100, Math.max(0, (generated / total) * 100)) : running ? 12 : 100;
  el.budgetRecomputeProgressBar.style.width = `${width}%`;
  el.budgetRecomputeProgressBar.classList.toggle('is-indeterminate', running && total <= 0);
  el.budgetRecomputeProgressText.textContent = `已生成建议 ${generated} / ${total}`;

  if (error) {
    el.budgetRecomputeProgressHint.textContent = `生成失败：${error}`;
    return;
  }

  if (running) {
    if (currentApp) {
      el.budgetRecomputeProgressHint.textContent = `正在处理 ${currentApp}（应用 ${Math.min(processedApps + 1, totalApps || 1)} / ${totalApps || '-'}）`;
    } else if (total > 0) {
      el.budgetRecomputeProgressHint.textContent = `候选建议已确定，正在生成说明与入库。`;
    } else {
      el.budgetRecomputeProgressHint.textContent = '正在扫描候选建议，请稍候...';
    }
    return;
  }

  el.budgetRecomputeProgressHint.textContent =
    total > 0
      ? `本轮已完成，共处理 ${totalApps} 个应用，成功生成 ${generated} 条建议。`
      : `本轮已完成，共处理 ${totalApps} 个应用，未生成新的建议。`;
}

async function loadBudgetRecomputeStatus() {
  const body = await api('/api/budget/recommendations/recompute/status');
  const progress = body.data || {};
  renderBudgetRecomputeProgress(progress);
  return progress;
}

async function pollBudgetRecomputeStatus() {
  stopBudgetRecomputePolling();
  const progress = await loadBudgetRecomputeStatus();
  if (progress.running) {
    budgetRecomputePollTimer = setTimeout(() => {
      pollBudgetRecomputeStatus().catch((error) => showToast(error.message || '预算建议进度加载失败', true));
    }, 1200);
  }
}

function asaHasSpendWithoutInstalls(totalCost, installs) {
  return Number(totalCost || 0) > 0 && Number(installs || 0) <= 0;
}

function asaHasCostWithoutD7Revenue(totalCost, revenueD7) {
  return Number(totalCost || 0) > 0 && Number(revenueD7 || 0) <= 0;
}

function formatAsaEcpiDisplay(value, totalCost, installs, options = {}) {
  const withCurrency = options.withCurrency !== false;
  if (asaHasSpendWithoutInstalls(totalCost, installs)) {
    return '—';
  }
  return withCurrency ? `$${toFixed2(value || 0)}` : `${toFixed2(value || 0)}`;
}

function formatAsaEcpiDisplayWithReason(value, totalCost, installs, options = {}) {
  const withCurrency = options.withCurrency !== false;
  if (asaHasSpendWithoutInstalls(totalCost, installs)) {
    return '—（有花费无安装）';
  }
  return withCurrency ? `$${toFixed2(value || 0)}` : `${toFixed2(value || 0)}`;
}

function formatAsaD7RoasDisplay(value, totalCost, revenueD7) {
  if (Number(totalCost || 0) <= 0) {
    return '-';
  }
  return `${toFixed2(value || 0)}x`;
}

function formatAsaD7RoasDisplayWithReason(value, totalCost, revenueD7) {
  if (Number(totalCost || 0) <= 0) {
    return '-';
  }
  const base = `${toFixed2(value || 0)}x`;
  return asaHasCostWithoutD7Revenue(totalCost, revenueD7) ? `${base}（未观察到D7收入）` : base;
}

function asaRecommendationBadgeClass(action) {
  return `badge-action-${String(action || 'hold')}`;
}

function renderAsaKeywordTable() {
  const rows = state.asaKeywordRows || [];
  if (rows.length === 0) {
    el.asaKeywordsTableBody.innerHTML =
      '<tr><td class="table-empty" colspan="16">当前筛选条件下暂无 ASA 关键词数据</td></tr>';
    return;
  }

  el.asaKeywordsTableBody.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(productViewName(row.app_key, row.platform || 'unknown'))}</td>
        <td class="table-cell-mono">${escapeHtml(row.app_key)}</td>
        <td>${escapeHtml(platformLabel(row.platform || 'unknown'))}</td>
        <td class="table-cell-wrap">${escapeHtml(row.keyword)}</td>
        <td class="table-cell-wrap">${escapeHtml(row.campaign)}</td>
        <td class="table-cell-wrap">${escapeHtml(row.adset || 'unknown')}</td>
        <td>${toFixed2(row.installs_7d || row.last_installs || 0)}</td>
        <td>$${toFixed2(row.total_cost_7d || 0)}</td>
        <td>${toFixed2(row.purchase_count_7d || 0)}</td>
        <td title="${escapeHtml(asaHasSpendWithoutInstalls(row.total_cost_7d, row.installs_7d || row.last_installs || 0) ? '当前有花费但没有安装，eCPI 不可计算' : '')}">${escapeHtml(formatAsaEcpiDisplay(row.current_ecpi || 0, row.total_cost_7d || 0, row.installs_7d || row.last_installs || 0))}</td>
        <td>${row.current_cpp > 0 ? `$${toFixed2(row.current_cpp)}` : '-'}</td>
        <td title="${escapeHtml(asaHasCostWithoutD7Revenue(row.total_cost_7d, row.revenue_d7_7d) ? '当前未观察到 D7 收入' : '')}">${escapeHtml(formatAsaD7RoasDisplay(row.current_d7_roas, row.total_cost_7d, row.revenue_d7_7d))}</td>
        <td><span class="badge badge-stage-${escapeHtml(row.current_stage)}">${asaStageLabel(row.current_stage)}</span></td>
        <td>${row.recommendation_action ? `<span class="badge ${asaRecommendationBadgeClass(row.recommendation_action)}">${escapeHtml(actionLabel(row.recommendation_action))}</span>` : '-'}</td>
        <td>${escapeHtml(asaRecommendationStatusLabel(row.recommendation_status))}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-ghost btn-compact" type="button" data-asa-keyword-view-id="${row.id}">详情</button>
          </div>
        </td>
      </tr>
    `
    )
    .join('');
}

function updateAsaKeywordPaginationUi() {
  el.asaKeywordPaginationInfo.textContent = `第 ${state.asaKeywordPage}/${state.asaKeywordTotalPages} 页 · 共 ${state.asaKeywordTotal} 条`;
  el.asaKeywordPrevPageBtn.disabled = state.asaKeywordPage <= 1;
  el.asaKeywordNextPageBtn.disabled = state.asaKeywordPage >= state.asaKeywordTotalPages;
}

async function loadAsaStageConfigs() {
  const body = await api('/api/asa-keywords/stages');
  state.asaStageConfigs = Array.isArray(body.data) ? body.data : [];
  syncAsaStageFormSelection();
}

async function saveAsaStageConfig(event) {
  event.preventDefault();
  const appKey = String(el.asaStageAppSelect.value || '').trim();
  const platform = String(el.asaStagePlatformSelect.value || '').trim().toLowerCase();
  const stage = String(el.asaStageStageSelect.value || 'rising').trim();
  if (!appKey || !platform) {
    throw new Error('请先选择应用与平台');
  }
  await api('/api/asa-keywords/stages', {
    method: 'POST',
    body: JSON.stringify({ appKey, platform, stage, enabled: true })
  });
  showToast(`已保存 ${productViewName(appKey, platform)} 的产品阶段`);
  await loadAsaStageConfigs();
  await loadAsaKeywords(undefined, 1);
}

function setDefaultAsaDateRange() {
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const reportDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  el.asaKeywordFromInput.value = toLocalDate(from);
  el.asaKeywordToInput.value = toLocalDate(now);
  el.asaBriefDateInput.value = toLocalDate(reportDate);
}

async function loadAsaKeywords(event, pageOverride) {
  if (event) {
    event.preventDefault();
  }
  const form = new FormData(el.asaKeywordFilter);
  const appKey = String(form.get('appKey') || '').trim();
  const platform = String(form.get('platform') || '').trim().toLowerCase();
  const stage = String(form.get('stage') || '').trim();
  const from = String(form.get('from') || '').trim();
  const to = String(form.get('to') || '').trim();
  const keyword = String(form.get('keyword') || '').trim();
  const campaign = String(form.get('campaign') || '').trim();
  const page = Number.isFinite(Number(pageOverride)) ? Number(pageOverride) : state.asaKeywordPage || 1;
  if (from && to && from > to) {
    throw new Error('ASA 关键词查询起始日期不能晚于结束日期');
  }

  const params = new URLSearchParams({ page: String(Math.max(1, page)) });
  if (appKey) params.set('appKey', appKey);
  if (platform) params.set('platform', platform);
  if (stage) params.set('stage', stage);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (keyword) params.set('keyword', keyword);
  if (campaign) params.set('campaign', campaign);

  const body = await api(`/api/asa-keywords?${params.toString()}`);
  state.asaKeywordRows = Array.isArray(body.data) ? body.data : [];
  state.asaKeywordPage = Number(body.meta?.page || 1);
  state.asaKeywordTotalPages = Number(body.meta?.totalPages || 1);
  state.asaKeywordTotal = Number(body.meta?.total || 0);
  updateAsaSummary(body.summary || {});
  renderAsaKeywordTable();
  updateAsaKeywordPaginationUi();
}

async function changeAsaKeywordPage(delta) {
  const next = state.asaKeywordPage + delta;
  if (next < 1 || next > state.asaKeywordTotalPages) {
    return;
  }
  await loadAsaKeywords(undefined, next);
}

async function openAsaKeywordDetail(row) {
  state.activeAsaKeywordDetail = row;
  const params = new URLSearchParams({
    appKey: row.app_key,
    platform: String(row.platform || 'unknown').toLowerCase(),
    campaign: row.campaign || '',
    adset: row.adset || 'unknown'
  });
  const body = await api(`/api/asa-keywords/${encodeURIComponent(row.keyword)}/trend?${params.toString()}`);
  const trendRows = Array.isArray(body.data) ? body.data : [];
  const chartRows = trendRows.map((item) => ({
    label: item.date,
    value: Number(item.installs || 0),
    tooltipLines: [
      `日期：${item.date}`,
      `安装量：${toFixed2(item.installs)}`,
      `成本：$${toFixed2(item.total_cost)}`,
      `Purchase：${toFixed2(item.purchase_count)}`,
      `eCPI：${formatAsaEcpiDisplayWithReason(item.ecpi, item.total_cost, item.installs)}`,
      `官方 eCPI：$${toFixed2(item.average_ecpi || 0)}`,
      `CPP：${Number(item.cpp || 0) > 0 ? `$${toFixed2(item.cpp)}` : '-'}`,
      `D7 ROAS：${formatAsaD7RoasDisplayWithReason(item.d7_roas, item.total_cost, item.revenue_d7)}`
    ]
  }));
  drawLineChart(el.asaKeywordTrendCanvas, chartRows);
  const llmSummary = safeJsonParse(row.llm_summary, {});
  el.asaKeywordDrawerMeta.textContent =
    `产品视图=${productViewName(row.app_key, row.platform || 'unknown')} · 应用=${row.app_key} · 平台=${platformLabel(row.platform || 'unknown')} · 关键词=${row.keyword} · Campaign=${row.campaign} · 广告组=${row.adset || 'unknown'} · 阶段=${asaStageLabel(row.current_stage)} · 建议指标=${asaPrimaryMetricLabel(row.primary_metric)}`;
  const last = trendRows.at(-1);
  el.asaKeywordTrendLegend.textContent =
    `数据点=${trendRows.length} · 最新安装量=${toFixed2(last?.installs)} · 最新 eCPI=${formatAsaEcpiDisplayWithReason(last?.ecpi, last?.total_cost, last?.installs)} · 官方 eCPI=$${toFixed2(last?.average_ecpi || 0)} · 最新 D7 ROAS=${formatAsaD7RoasDisplayWithReason(last?.d7_roas, last?.total_cost, last?.revenue_d7)}`;
  el.asaKeywordTrendRaw.textContent = JSON.stringify(
    {
      recommendation: {
        action: row.recommendation_action,
        status: row.recommendation_status,
        summary: llmSummary.summary_cn || '',
        explanation_points: llmSummary.explanation_points || []
      },
      note: 'ASA 关键词成本直接来自 AppsFlyer Master API（关键词 + 广告系列 + 广告组）。eCPI 显示为“—”表示有花费无安装；D7 ROAS 显示 0.00x 表示当前未观察到 D7 收入。',
      trend: trendRows
    },
    null,
    2
  );
  setAsaKeywordDrawerOpen(true);
}

async function handleAsaKeywordTableClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const rowId = Number(target.dataset.asaKeywordViewId || 0);
  if (!rowId) return;
  const row = state.asaKeywordRows.find((item) => Number(item.id) === rowId);
  if (!row) return;
  await openAsaKeywordDetail(row);
}

async function triggerAsaKeywordRecompute() {
  if (el.asaKeywordRecomputeBtn.disabled) return;
  const originalText = el.asaKeywordRecomputeBtn.textContent || '手动重算';
  el.asaKeywordRecomputeBtn.disabled = true;
  el.asaKeywordRecomputeBtn.textContent = '重算中...';
  try {
    const body = await api('/api/asa-keywords/recompute', {
      method: 'POST',
      body: JSON.stringify({ backfillDays: 30 })
    });
    const result = body.data || {};
    showToast(`ASA 关键词重算完成：状态 ${result.state_rows || 0} / 建议 ${result.recommendation_rows || 0}`);
    state.asaKeywordPage = 1;
    await loadAsaKeywords(undefined, 1);
  } finally {
    el.asaKeywordRecomputeBtn.disabled = false;
    el.asaKeywordRecomputeBtn.textContent = originalText;
  }
}

function asaBriefSummaryItems(report) {
  const summary = report.summary || {};
  return [
    { label: '当前阶段', value: asaStageLabel(report.current_stage) },
    { label: '关键词数', value: String(summary.keyword_count || 0) },
    { label: '安装量', value: toFixed2(summary.installs || 0) },
    { label: '成本', value: `$${toFixed2(summary.total_cost || 0)}` },
    { label: 'eCPI', value: formatAsaEcpiDisplay(summary.ecpi || 0, summary.total_cost || 0, summary.installs || 0) },
    { label: 'CPP', value: Number(summary.cpp || 0) > 0 ? `$${toFixed2(summary.cpp || 0)}` : '-' },
    { label: 'D7 ROAS', value: formatAsaD7RoasDisplay(summary.d7_roas || 0, summary.total_cost || 0, summary.revenue_d7 || 0) }
  ];
}

function renderAsaBriefModal(payload, mode) {
  const report = payload?.report || payload || {};
  const notify = payload?.notify || null;
  const skipped = payload?.skipped === true;
  const actionRows = Array.isArray(report.action_rows) ? report.action_rows : [];
  el.asaBriefModalTitle.textContent = mode === 'send' ? 'ASA 简报发送结果' : 'ASA 简报预览';
  el.asaBriefMeta.textContent =
    `报告日期 ${report.report_date || '-'} · 当前阶段 ${asaStageLabel(report.current_stage)} · 关键词数 ${report.summary?.keyword_count || 0}` +
    (notify?.ok ? ` · Feishu 状态 ${notify.status || 200}` : '') +
    (skipped ? ' · 当日已发送，本次跳过' : '');
  el.asaBriefSummaryGrid.innerHTML = asaBriefSummaryItems(report)
    .map(
      (item) => `
        <article class="daily-brief-metric">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </article>
      `
    )
    .join('');
  el.asaBriefJudgment.textContent =
    report.today_judgment ||
    (report.current_stage === 'stable'
      ? '当前已按稳定期口径输出建议，优先观察 D7 ROAS 与 CPP 是否同步达标。成本直接取自 AppsFlyer Master API。'
      : '当前按上升期口径输出建议，优先观察 eCPI 与安装扩张效率。成本直接取自 AppsFlyer Master API。');
  el.asaBriefActions.innerHTML = actionRows.length
    ? actionRows
        .slice(0, 12)
        .map((row) => {
          const llmSummary = safeJsonParse(row.llm_summary, {});
          return `
            <article class="daily-brief-action-card priority-P2">
              <div class="daily-brief-action-head">
                <span class="badge ${asaRecommendationBadgeClass(row.action)}">${escapeHtml(actionLabel(row.action))}</span>
                <strong>${escapeHtml(productViewName(row.app_key, row.platform))} / ${escapeHtml(row.keyword)}</strong>
              </div>
              <p>Campaign：${escapeHtml(row.campaign)}</p>
              <p>广告组：${escapeHtml(row.adset || 'unknown')}</p>
              <p>${escapeHtml(
                row.primary_metric === 'd7_roas_cpp'
                  ? `D7 ROAS ${formatAsaD7RoasDisplayWithReason(row.current_d7_roas, row.total_cost_7d, row.revenue_d7_7d)} / 目标 ${toFixed2(row.target_d7_roas)}x ｜ CPP ${row.current_cpp > 0 ? `$${toFixed2(row.current_cpp)}` : '-'} / 目标 ${row.target_cpp > 0 ? `$${toFixed2(row.target_cpp)}` : '-'}`
                  : `当前 eCPI ${formatAsaEcpiDisplayWithReason(row.current_ecpi, row.total_cost_7d, row.installs_7d)} / 目标 $${toFixed2(row.target_ecpi)}`
              )}</p>
              <p>${escapeHtml(String(llmSummary.summary_cn || row.reason_code || '暂无补充说明'))}</p>
            </article>
          `;
        })
        .join('')
    : '<p class="hint">当前没有可纳入简报的建议操作。</p>';
  el.asaBriefRaw.textContent = JSON.stringify(report.feishu_card_payload || {}, null, 2);
  setAsaBriefModalOpen(true);
}

function setAsaBriefModalOpen(open) {
  el.asaBriefModal.classList.toggle('hidden', !open);
}

async function previewAsaBrief(event) {
  if (event) event.preventDefault();
  const reportDate = String(el.asaBriefDateInput.value || '').trim();
  if (!reportDate) throw new Error('请先选择报告日期');
  const params = new URLSearchParams({ reportDate });
  const appKey = String(el.asaBriefAppSelect.value || '').trim();
  const platform = String(el.asaBriefPlatformSelect.value || '').trim().toLowerCase();
  if (appKey) params.set('appKey', appKey);
  if (platform) params.set('platform', platform);
  const body = await api(`/api/asa-keywords/brief/preview?${params.toString()}`);
  renderAsaBriefModal(body.data, 'preview');
  el.asaBriefStatus.textContent = `已生成 ${reportDate} 的 ASA 简报预览，建议操作已并入简报。`;
}

async function sendAsaBrief() {
  const reportDate = String(el.asaBriefDateInput.value || '').trim();
  if (!reportDate) throw new Error('请先选择报告日期');
  const appKey = String(el.asaBriefAppSelect.value || '').trim();
  const platform = String(el.asaBriefPlatformSelect.value || '').trim().toLowerCase();
  const body = await api('/api/asa-keywords/brief/send', {
    method: 'POST',
    body: JSON.stringify({ reportDate, appKey: appKey || undefined, platform: platform || undefined, force: true })
  });
  renderAsaBriefModal(body.data, 'send');
  el.asaBriefStatus.textContent = `ASA 简报已发送：${reportDate}，建议操作已随简报一并发送。`;
  showToast('ASA 简报已发送');
}

async function loadMetrics(event) {
  if (event) event.preventDefault();

  const form = new FormData(el.metricsForm);
  const appKey = String(form.get('appKey') || '').trim();
  const source = String(form.get('source') || 'push').trim();
  const platform = String(form.get('platform') || '').trim().toLowerCase();
  const metric = String(form.get('metric') || (source === 'pull' ? 'installs' : 'revenue')).trim();
  const eventName = String(form.get('eventName') || '').trim();

  if (!appKey) {
    showToast('请先选择应用', true);
    return;
  }

  const to = new Date();
  const params = new URLSearchParams({
    appKey,
    metric,
    source
  });
  if (platform) {
    params.set('platform', platform);
  }
  if (source === 'pull') {
    const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
    params.set('from', toSqlDate(from));
    params.set('to', toSqlDate(to));
    params.set('granularity', 'day');
  } else {
    const from = new Date(to.getTime() - 72 * 60 * 60 * 1000);
    params.set('from', toSqlDateTime(from));
    params.set('to', toSqlDateTime(to));
    params.set('granularity', 'hour');
    if (eventName) params.set('eventName', eventName);
  }

  const body = await api(`/api/metrics?${params.toString()}`);
  const rows = body.data || [];
  const chartRows = rows.map((item) => ({
    ...item,
    label: item.hour || item.date,
    value: Number(item.value || 0),
    tooltipLines: [
      `${source === 'pull' ? '日期' : '时间'}：${formatChartLabel(item.hour || item.date)}`,
      `指标：${metricLabel(metric)}`,
      `数值：${toFixed2(item.value)}`
    ]
  }));
  drawLineChart(el.metricsCanvas, chartRows);

  const last = rows.at(-1);
  const lastValue = last ? Number(last.value).toFixed(2) : '无';
  if (source === 'pull' && rows.length === 0) {
    el.metricsLegend.textContent =
      '暂无 Pull 数据。请检查 Pull token、PULLER_BACKFILL_DAYS，并查看 puller 日志。';
    return;
  }
  el.metricsLegend.textContent = `数据点=${rows.length} · 最新值=${lastValue} · 来源=${source === 'pull' ? 'Pull(日)' : 'Push(小时)'}`;
}

function renderOperationLogsTable() {
  const rows = state.operationLogs || [];
  if (rows.length === 0) {
    el.operationLogsTableBody.innerHTML =
      '<tr><td class="table-empty" colspan="7">当前筛选条件下暂无操作日志</td></tr>';
    return;
  }

  el.operationLogsTableBody.innerHTML = rows
    .map((row) => {
      const detail = safeJsonParse(row.detail_json, row.detail_json || {});
      const pretty = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
      return `
        <tr>
          <td class="table-cell-mono">${escapeHtml(fmtTime(row.created_at))}</td>
          <td class="table-cell-mono">${escapeHtml(row.source)}</td>
          <td>${escapeHtml(row.action)}</td>
          <td class="table-cell-wrap">${escapeHtml(`${row.target_type || '-'} / ${row.target_key || '-'}`)}</td>
          <td><span class="badge badge-${escapeHtml(row.status)}">${escapeHtml(operationStatusLabel(row.status))}</span></td>
          <td class="table-cell-wrap">${escapeHtml(row.summary || '-')}</td>
          <td>
            <details>
              <summary>查看</summary>
              <pre class="log-detail-pre">${escapeHtml(pretty)}</pre>
            </details>
          </td>
        </tr>
      `;
    })
    .join('');
}

async function loadOperationLogs(event) {
  if (event) {
    event.preventDefault();
  }
  const form = new FormData(el.operationLogsFilter);
  const params = new URLSearchParams();
  for (const [key, value] of form.entries()) {
    const text = String(value || '').trim();
    if (text) {
      params.set(key, text);
    }
  }
  const body = await api(`/api/operation-logs?${params.toString()}`);
  state.operationLogs = Array.isArray(body.data) ? body.data : [];
  renderOperationLogsTable();
}

async function refreshOverviewTotals() {
  const [ruleResp, openAlertResp] = await Promise.all([api('/api/rules'), api('/api/alerts?status=open')]);
  state.ruleTotalCount = Array.isArray(ruleResp.data) ? ruleResp.data.length : 0;
  state.openAlertTotalCount = Array.isArray(openAlertResp.data) ? openAlertResp.data.length : 0;
}

async function safeRefresh(stepName, loader) {
  try {
    await loader();
  } catch (error) {
    console.error(`[refreshAll] ${stepName} failed`, error);
    showToast(`${stepName}加载失败：${error.message || '请稍后重试'}`, true);
  }
}

async function refreshAll() {
  await loadApps();
  await refreshOverviewTotals();
  await loadRuntimeSchedule();
  const now = new Date();
  updateOverviewCards(now);

  const firstApp = state.apps[0]?.app_key || '';
  await safeRefresh('规则列表', () => loadRules(firstApp));

  el.alertsAppSelect.value = firstApp;
  await safeRefresh('告警列表', () => loadAlerts());

  if (firstApp) {
    el.metricsAppSelect.value = firstApp;
    await safeRefresh('趋势图', () => loadMetrics());
  }

  state.pullPage = 1;
  await safeRefresh('Pull 明细', () => loadPullRecords(undefined, 1));

  state.keywordPage = 1;
  await safeRefresh('关键词生命周期', () => loadKeywordLifecycle(undefined, 1));

  state.budgetPage = 1;
  await safeRefresh('预算建议', () => loadBudgetRecommendations(undefined, 1));
  await safeRefresh('预算建议进度', () => loadBudgetRecomputeStatus());
  await safeRefresh('ASA 阶段配置', () => loadAsaStageConfigs());
  state.asaKeywordPage = 1;
  await safeRefresh('ASA 关键词', () => loadAsaKeywords(undefined, 1));
  await safeRefresh('操作日志', () => loadOperationLogs());
  await safeRefresh('日报媒体源', () => loadDailyBriefMediaSources(true));
  await safeRefresh('多维表格配置', () => loadBitableExportConfigs());

  el.lastUpdated.textContent = `更新时间 ${now.toLocaleTimeString()}`;
  updateOverviewCards(now);
}

async function bootstrap() {
  ruleField('rule_json').value = JSON.stringify(defaultRule, null, 2);
  loadDslFormFromRule(defaultRule);
  setDefaultPullDateRange();
  setDefaultKeywordDateRange();
  setDefaultBudgetDateRange();
  setDefaultAsaDateRange();
  setDefaultDailyBriefDate();
  setDefaultBitableExportDate();
  if (el.runtimePullTimeInput) {
    el.runtimePullTimeInput.value = '09:00';
  }
  if (el.runtimePushTimeInput) {
    el.runtimePushTimeInput.value = '10:00';
  }
  renderRuntimeSchedulePreview();
  syncAppFeishuSection();
  applyUniformFieldLabels();
  setActiveNav('section-overview');
  setupSideNav();
  bindChartHover(el.metricsCanvas, el.metricsTooltip);
  bindChartHover(el.keywordTrendCanvas, el.keywordTooltip);
  bindChartHover(el.asaKeywordTrendCanvas, el.asaKeywordTooltip);

  window.addEventListener('scroll', syncActiveSectionOnScroll, { passive: true });
  window.addEventListener('resize', () => {
    const metricsState = chartState.get(el.metricsCanvas);
    if (metricsState) {
      drawLineChart(el.metricsCanvas, metricsState.rows, metricsState.options);
    }
    const keywordState = chartState.get(el.keywordTrendCanvas);
    if (keywordState) {
      drawLineChart(el.keywordTrendCanvas, keywordState.rows, keywordState.options);
    }
    const asaKeywordState = chartState.get(el.asaKeywordTrendCanvas);
    if (asaKeywordState) {
      drawLineChart(el.asaKeywordTrendCanvas, asaKeywordState.rows, asaKeywordState.options);
    }
  });

  try {
    setMetricsMode('pull');
    await refreshAll();
  } catch (error) {
    showToast(error.message || '初始化失败', true);
  }
}

el.appForm.addEventListener('submit', (e) => saveAppConfig(e).catch((err) => showToast(err.message || '保存失败', true)));
el.appResetBtn.addEventListener('click', () => {
  resetAppEditor();
  showToast('已切换到新建模式');
});
el.appsTableBody.addEventListener('click', (e) =>
  handleAppsTableClick(e).catch((err) => showToast(err.message || '编辑失败', true))
);
el.generateTokenBtn.addEventListener('click', () => {
  appField('push_auth_token').value = generateToken();
});
el.appFeishuEnabled.addEventListener('change', () => {
  state.appFeishuEnabled = el.appFeishuEnabled.checked;
  syncAppFeishuSection();
});

el.ruleForm.addEventListener('submit', (e) => saveRule(e).catch((err) => showToast(err.message || '规则保存失败', true)));
el.rulesList.addEventListener('click', (e) => handleRulesListClick(e).catch((err) => showToast(err.message || '规则操作失败', true)));
el.buildDslJsonBtn.addEventListener('click', () => {
  const json = buildRuleFromDslForm();
  ruleField('rule_json').value = JSON.stringify(json, null, 2);
  showToast('已根据表单生成 JSON');
});
el.loadDslFromJsonBtn.addEventListener('click', () => {
  try {
    const parsed = JSON.parse(ruleField('rule_json').value || '{}');
    loadDslFormFromRule(parsed);
    showToast('已根据 JSON 回填表单');
  } catch (err) {
    showToast(err.message || 'JSON 格式无效', true);
  }
});

el.alertsFilter.addEventListener('submit', (e) => loadAlerts(e).catch((err) => showToast(err.message || '告警加载失败', true)));
el.alertsTableBody.addEventListener('click', (e) =>
  handleAlertsTableClick(e).catch((err) => showToast(err.message || '告警详情加载失败', true))
);
el.closeAlertDrawerBtn.addEventListener('click', () => setDrawerOpen(false));
el.alertDrawerBackdrop.addEventListener('click', () => setDrawerOpen(false));

el.metricsForm.addEventListener('submit', (e) => loadMetrics(e).catch((err) => showToast(err.message || '指标加载失败', true)));
function triggerMetricsAutoRefresh() {
  if (!String(el.metricsAppSelect.value || '').trim()) {
    return;
  }
  loadMetrics().catch((err) => showToast(err.message || '指标加载失败', true));
}

el.metricsSourceSelect.addEventListener('change', () => {
  const source = el.metricsSourceSelect.value || 'pull';
  setMetricsMode(source);
  triggerMetricsAutoRefresh();
});
el.metricsAppSelect.addEventListener('change', triggerMetricsAutoRefresh);
el.metricsPlatformSelect.addEventListener('change', triggerMetricsAutoRefresh);
el.metricsMetricSelect.addEventListener('change', triggerMetricsAutoRefresh);
el.pullRecordsFilter.addEventListener('submit', (e) =>
  loadPullRecords(e, 1).catch((err) => showToast(err.message || 'Pull 明细加载失败，请检查 API 与 ClickHouse 连接', true))
);
el.pullRecordsTableBody.addEventListener('click', (e) =>
  handlePullRecordsTableClick(e).catch((err) => showToast(err.message || 'Pull 行详情加载失败', true))
);
el.pullPrevPageBtn.addEventListener('click', () =>
  changePullPage(-1).catch((err) => showToast(err.message || '翻页失败', true))
);
el.pullNextPageBtn.addEventListener('click', () =>
  changePullPage(1).catch((err) => showToast(err.message || '翻页失败', true))
);
el.triggerPullBtn.addEventListener('click', () =>
  triggerPullOnce().catch((err) => showToast(err.message || '手动读取失败', true))
);
el.pullResultModalCloseBtn.addEventListener('click', () => setPullResultModalOpen(false));
el.pullResultModalBackdrop.addEventListener('click', () => setPullResultModalOpen(false));
el.keywordFilter.addEventListener('submit', (e) =>
  loadKeywordLifecycle(e, 1).catch((err) => showToast(err.message || '关键词生命周期加载失败', true))
);
el.keywordsTableBody.addEventListener('click', (e) =>
  handleKeywordTableClick(e).catch((err) => showToast(err.message || '关键词趋势加载失败', true))
);
el.keywordPrevPageBtn.addEventListener('click', () =>
  changeKeywordPage(-1).catch((err) => showToast(err.message || '关键词翻页失败', true))
);
el.keywordNextPageBtn.addEventListener('click', () =>
  changeKeywordPage(1).catch((err) => showToast(err.message || '关键词翻页失败', true))
);
el.keywordRecomputeBtn.addEventListener('click', () =>
  triggerKeywordRecompute().catch((err) => showToast(err.message || '关键词重算失败', true))
);
el.closeKeywordDrawerBtn.addEventListener('click', () => setKeywordDrawerOpen(false));
el.keywordDrawerBackdrop.addEventListener('click', () => setKeywordDrawerOpen(false));

el.asaStageForm.addEventListener('submit', (e) =>
  saveAsaStageConfig(e).catch((err) => showToast(err.message || 'ASA 阶段保存失败', true))
);
el.asaStageAppSelect.addEventListener('change', syncAsaStageFormSelection);
el.asaStagePlatformSelect.addEventListener('change', syncAsaStageFormSelection);
el.asaKeywordFilter.addEventListener('submit', (e) =>
  loadAsaKeywords(e, 1).catch((err) => showToast(err.message || 'ASA 关键词加载失败', true))
);
el.asaKeywordsTableBody.addEventListener('click', (e) =>
  handleAsaKeywordTableClick(e).catch((err) => showToast(err.message || 'ASA 关键词详情加载失败', true))
);
el.asaKeywordPrevPageBtn.addEventListener('click', () =>
  changeAsaKeywordPage(-1).catch((err) => showToast(err.message || 'ASA 关键词翻页失败', true))
);
el.asaKeywordNextPageBtn.addEventListener('click', () =>
  changeAsaKeywordPage(1).catch((err) => showToast(err.message || 'ASA 关键词翻页失败', true))
);
el.asaKeywordRecomputeBtn.addEventListener('click', () =>
  triggerAsaKeywordRecompute().catch((err) => showToast(err.message || 'ASA 关键词重算失败', true))
);
el.asaBriefForm.addEventListener('submit', (e) =>
  previewAsaBrief(e).catch((err) => showToast(err.message || 'ASA 简报预览失败', true))
);
el.sendAsaBriefBtn.addEventListener('click', () =>
  sendAsaBrief().catch((err) => showToast(err.message || 'ASA 简报发送失败', true))
);
el.closeAsaKeywordDrawerBtn.addEventListener('click', () => setAsaKeywordDrawerOpen(false));
el.asaKeywordDrawerBackdrop.addEventListener('click', () => setAsaKeywordDrawerOpen(false));
el.asaBriefModalCloseBtn.addEventListener('click', () => setAsaBriefModalOpen(false));
el.asaBriefModalBackdrop.addEventListener('click', () => setAsaBriefModalOpen(false));

el.budgetFilter.addEventListener('submit', (e) =>
  loadBudgetRecommendations(e, 1).catch((err) => showToast(err.message || '预算建议加载失败', true))
);
el.budgetTableBody.addEventListener('click', (e) =>
  handleBudgetTableClick(e).catch((err) => showToast(err.message || '预算建议操作失败', true))
);
el.budgetPrevPageBtn.addEventListener('click', () =>
  changeBudgetPage(-1).catch((err) => showToast(err.message || '预算建议翻页失败', true))
);
el.budgetNextPageBtn.addEventListener('click', () =>
  changeBudgetPage(1).catch((err) => showToast(err.message || '预算建议翻页失败', true))
);
el.budgetRecomputeBtn.addEventListener('click', () =>
  triggerBudgetRecompute().catch((err) => showToast(err.message || '预算建议生成失败', true))
);
el.closeBudgetDetailModalBtn.addEventListener('click', () => setBudgetDetailModalOpen(false));
el.budgetDetailModalBackdrop.addEventListener('click', () => setBudgetDetailModalOpen(false));

el.runtimeScheduleForm?.addEventListener('submit', (e) =>
  saveRuntimeSchedule(e).catch((err) => showToast(err.message || '调度时间保存失败', true))
);
el.runtimePullTimeInput?.addEventListener('input', renderRuntimeSchedulePreview);
el.runtimePushTimeInput?.addEventListener('input', renderRuntimeSchedulePreview);

el.refreshAllBtn.addEventListener('click', () =>
  refreshAll().catch((err) => showToast(err.message || '刷新失败', true))
);
el.logoutBtn?.addEventListener('click', async () => {
  try {
    await fetch('/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    });
  } finally {
    window.location.assign('/login');
  }
});
el.operationLogsFilter.addEventListener('submit', (e) =>
  loadOperationLogs(e).catch((err) => showToast(err.message || '操作日志加载失败', true))
);
el.dailyBriefForm.addEventListener('submit', (e) =>
  previewDailyBrief(e).catch((err) => showToast(err.message || '日报预览失败', true))
);
el.dailyBriefDateInput.addEventListener('change', () =>
  loadDailyBriefMediaSources(false).catch((err) => showToast(err.message || '媒体源列表加载失败', true))
);
el.dailyBriefMediaSources.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.name !== 'dailyBriefMediaSource') {
    return;
  }
  const value = String(target.value || '').trim();
  if (!value) {
    return;
  }
  if (target.checked) {
    if (!state.dailyBriefSelectedMediaSources.includes(value)) {
      state.dailyBriefSelectedMediaSources = [...state.dailyBriefSelectedMediaSources, value];
    }
  } else {
    state.dailyBriefSelectedMediaSources = state.dailyBriefSelectedMediaSources.filter((item) => item !== value);
  }
  updateDailyBriefMediaSourceSummary();
});
el.dailyBriefSelectAllMediaBtn.addEventListener('click', () => {
  state.dailyBriefSelectedMediaSources = [...state.dailyBriefMediaSources];
  renderDailyBriefMediaSources();
});
el.dailyBriefClearMediaBtn.addEventListener('click', () => {
  state.dailyBriefSelectedMediaSources = [];
  renderDailyBriefMediaSources();
});
el.sendDailyBriefBtn.addEventListener('click', () =>
  sendDailyBriefOnce().catch((err) => showToast(err.message || '日报发送失败', true))
);
el.bitableExportCards?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const card = target.closest('.bitable-export-card');
  if (!(card instanceof HTMLElement)) {
    return;
  }
  const sourceType = String(card.dataset.sourceType || '').trim();
  if (!sourceType) {
    return;
  }
  if (target.dataset.role === 'save-config') {
    saveBitableExportCard(sourceType).catch((err) => showToast(err.message || '配置保存失败', true));
    return;
  }
  if (target.dataset.role === 'run-export') {
    runBitableExportCard(sourceType).catch((err) => showToast(err.message || '导出执行失败', true));
  }
});
el.bitableExportCards?.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  const card = target.closest('.bitable-export-card');
  refreshBitableFieldCount(card);
});
el.dailyBriefModalCloseBtn.addEventListener('click', () => setDailyBriefModalOpen(false));
el.dailyBriefModalBackdrop.addEventListener('click', () => setDailyBriefModalOpen(false));

initializeHelpPopovers();

helpPopoverGroups.forEach((group) => {
  const popover = getHelpPopover(group);
  group.addEventListener('mouseenter', () => showHelpPopover(group));
  group.addEventListener('mouseleave', () => scheduleHideHelpPopover(group));
  group.addEventListener('focusin', () => showHelpPopover(group));
  group.addEventListener('focusout', (event) => handleHelpFocusOut(group, event));
  if (popover) {
    popover.addEventListener('mouseenter', () => showHelpPopover(group));
    popover.addEventListener('mouseleave', () => scheduleHideHelpPopover(group));
  }
});

window.addEventListener('resize', refreshHelpPopoverPositions);
window.addEventListener(
  'scroll',
  () => {
    if (scrollTicking) {
      return;
    }
    scrollTicking = true;
    requestAnimationFrame(() => {
      refreshHelpPopoverPositions();
      scrollTicking = false;
    });
  },
  true
);

bootstrap();

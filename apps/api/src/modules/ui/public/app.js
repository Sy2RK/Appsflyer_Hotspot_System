import {
  POLICY_ENGINE_LABELS,
  createPolicyTemplate,
  buildPolicyDraftFromRow,
  sanitizeRecommendationPolicyDraft,
  mergeRecommendationPolicyRule,
  buildRecommendationPolicySnapshot,
  buildRecommendationPolicyTableSummary,
  buildRecommendationPolicyReviewSummary,
  getRecommendationPolicyErrorMessage,
  createEmptyTargetRow
} from './recommendationPolicyWizard.js';

function createInitialRecommendationPolicyEditor() {
  const draft = createPolicyTemplate({ platform: '', appKey: '', engine: '' }, 'blank');
  return {
    step: 1,
    source: 'unselected',
    selection: {
      platform: '',
      appKey: '',
      engine: ''
    },
    originalRuleJson: {},
    originalSnapshot: buildRecommendationPolicySnapshot(draft),
    draft,
    dirty: false
  };
}

const state = {
  apps: [],
  alerts: [],
  rules: [],
  pullRecords: [],
  keywordRows: [],
  keywordLoadedAt: '',
  budgetRows: [],
  asaKeywordRows: [],
  metricsRows: [],
  metricsQuery: null,
  metricsLoadedAt: '',
  pullRecordsLoadedAt: '',
  budgetLoadedAt: '',
  asaSummary: null,
  asaKeywordsLoadedAt: '',
  dailyBriefPreviewPayload: null,
  dailyBriefPreviewLoadedAt: '',
  asaBriefPreviewPayload: null,
  asaBriefPreviewLoadedAt: '',
  asaStageConfigs: [],
  recommendationPolicies: [],
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
  dailyBriefSelectedMediaSources: [],
  rulesSectionExpanded: false,
  recommendationPolicyEditor: createInitialRecommendationPolicyEditor(),
  aiChat: {
    aiDockOpen: false,
    scrollLocked: false,
    messages: [],
    pending: false,
    availableModels: [],
    defaultModelId: '',
    currentModelId: '',
    selectedImages: [],
    selectedContextPacks: [],
    contextMenuOpen: false,
    activeToolSection: 'database',
    activeToolSubsection: 'recommended'
  }
};

let budgetRecomputePollTimer = null;
let aiDockScrollY = 0;
let aiDockPreviousFocus = null;
let aiDockDragState = null;
let aiDockSuppressToggleClick = false;

const PUSH_METRIC_OPTIONS = [
  { value: 'revenue', label: '收入金额' },
  { value: 'event_count', label: '事件次数' },
  { value: 'purchase_count', label: '购买次数' }
];

const PULL_METRIC_OPTIONS = [
  { value: 'installs', label: '安装量' },
  { value: 'clicks', label: '点击量' },
  { value: 'total_cost', label: '花费金额' }
];

const AI_CHAT_PACK_TEMPLATES = {
  metrics_trend: [
    { value: 'media_source', label: '按媒体源' },
    { value: 'country', label: '按国家' },
    { value: 'campaign', label: '按活动' }
  ],
  budget_summary: [
    { value: 'platform_media_source', label: '按平台 / 媒体源' },
    { value: 'action_status', label: '按动作 / 状态' },
    { value: 'keyword', label: '按关键词' }
  ],
  asa_keyword_summary: [
    { value: 'stage', label: '按阶段' },
    { value: 'campaign_adset', label: '按活动 / 广告组' },
    { value: 'keyword', label: '按关键词' }
  ]
};

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
  appShell: document.getElementById('appShell'),
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
  toggleRulesSectionBtn: document.getElementById('toggleRulesSectionBtn'),
  rulesSectionBody: document.getElementById('rulesSectionBody'),
  rulesSectionSummary: document.getElementById('rulesSectionSummary'),

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
  budgetExecutionStatusInput: document.getElementById('budgetExecutionStatusInput'),
  budgetAdoptedSelect: document.getElementById('budgetAdoptedSelect'),
  budgetManualReviewSelect: document.getElementById('budgetManualReviewSelect'),
  budgetTableBody: document.getElementById('budgetTableBody'),
  budgetPrevPageBtn: document.getElementById('budgetPrevPageBtn'),
  budgetNextPageBtn: document.getElementById('budgetNextPageBtn'),
  budgetPaginationInfo: document.getElementById('budgetPaginationInfo'),
  budgetExportFeedbackBtn: document.getElementById('budgetExportFeedbackBtn'),
  budgetDownloadSkillsBtn: document.getElementById('budgetDownloadSkillsBtn'),
  budgetRecomputeBtn: document.getElementById('budgetRecomputeBtn'),
  budgetRecomputeProgress: document.getElementById('budgetRecomputeProgress'),
  budgetRecomputeProgressBar: document.getElementById('budgetRecomputeProgressBar'),
  budgetRecomputeProgressText: document.getElementById('budgetRecomputeProgressText'),
  budgetRecomputeProgressHint: document.getElementById('budgetRecomputeProgressHint'),
  budgetRuleHelpBtn: document.getElementById('budgetRuleHelpBtn'),
  recommendationPolicyEmptyState: document.getElementById('recommendationPolicyEmptyState'),
  recommendationPolicyStateBadge: document.getElementById('recommendationPolicyStateBadge'),
  recommendationPolicyStatusTitle: document.getElementById('recommendationPolicyStatusTitle'),
  recommendationPolicyStatus: document.getElementById('recommendationPolicyStatus'),
  recommendationPolicyUseRecommendedBtn: document.getElementById('recommendationPolicyUseRecommendedBtn'),
  recommendationPolicyUseBlankBtn: document.getElementById('recommendationPolicyUseBlankBtn'),
  recommendationPolicySteps: document.getElementById('recommendationPolicySteps'),
  recommendationPolicyForm: document.getElementById('recommendationPolicyForm'),
  recommendationPolicyAppSelect: document.getElementById('recommendationPolicyAppSelect'),
  recommendationPolicyPlatformSelect: document.getElementById('recommendationPolicyPlatformSelect'),
  recommendationPolicyEngineSelect: document.getElementById('recommendationPolicyEngineSelect'),
  recommendationPolicySelectionPreview: document.getElementById('recommendationPolicySelectionPreview'),
  recommendationPolicySourceSummary: document.getElementById('recommendationPolicySourceSummary'),
  recommendationPolicyMetricFamilySelect: document.getElementById('recommendationPolicyMetricFamilySelect'),
  recommendationPolicyEcpiGroup: document.getElementById('recommendationPolicyEcpiGroup'),
  recommendationPolicyRoasGroup: document.getElementById('recommendationPolicyRoasGroup'),
  recommendationPolicyRelativeGroup: document.getElementById('recommendationPolicyRelativeGroup'),
  recommendationPolicyTargetOverridesBlock: document.getElementById('recommendationPolicyTargetOverridesBlock'),
  recommendationPolicyDecisionModeSelect: document.getElementById('recommendationPolicyDecisionModeSelect'),
  recommendationPolicyTrafficScopeSelect: document.getElementById('recommendationPolicyTrafficScopeSelect'),
  recommendationPolicyMediaSourcesPanel: document.getElementById('recommendationPolicyMediaSourcesPanel'),
  recommendationPolicyMediaSourcesChips: document.getElementById('recommendationPolicyMediaSourcesChips'),
  recommendationPolicyMediaSourceDraftInput: document.getElementById('recommendationPolicyMediaSourceDraftInput'),
  recommendationPolicyAddMediaSourceBtn: document.getElementById('recommendationPolicyAddMediaSourceBtn'),
  recommendationPolicyExcludeRecentInput: document.getElementById('recommendationPolicyExcludeRecentInput'),
  recommendationPolicyDecisionWindowInput: document.getElementById('recommendationPolicyDecisionWindowInput'),
  recommendationPolicyContextWindowChips: document.getElementById('recommendationPolicyContextWindowChips'),
  recommendationPolicyContextWindowDraftInput: document.getElementById('recommendationPolicyContextWindowDraftInput'),
  recommendationPolicyAddContextWindowBtn: document.getElementById('recommendationPolicyAddContextWindowBtn'),
  recommendationPolicyEcpiMaxInput: document.getElementById('recommendationPolicyEcpiMaxInput'),
  recommendationPolicyRoasMinInput: document.getElementById('recommendationPolicyRoasMinInput'),
  recommendationPolicyRoasGoodInput: document.getElementById('recommendationPolicyRoasGoodInput'),
  recommendationPolicyCppMaxInput: document.getElementById('recommendationPolicyCppMaxInput'),
  recommendationPolicyCppPauseInput: document.getElementById('recommendationPolicyCppPauseInput'),
  recommendationPolicyRelativeUnderperformInput: document.getElementById('recommendationPolicyRelativeUnderperformInput'),
  recommendationPolicyRelativePeerCountInput: document.getElementById('recommendationPolicyRelativePeerCountInput'),
  recommendationPolicyRelativeMinFailedInput: document.getElementById('recommendationPolicyRelativeMinFailedInput'),
  recommendationPolicyCountryTargetsList: document.getElementById('recommendationPolicyCountryTargetsList'),
  recommendationPolicyMediaTargetsList: document.getElementById('recommendationPolicyMediaTargetsList'),
  recommendationPolicyAddCountryTargetBtn: document.getElementById('recommendationPolicyAddCountryTargetBtn'),
  recommendationPolicyAddMediaTargetBtn: document.getElementById('recommendationPolicyAddMediaTargetBtn'),
  recommendationPolicyDailyCapInput: document.getElementById('recommendationPolicyDailyCapInput'),
  recommendationPolicyLowSpendInput: document.getElementById('recommendationPolicyLowSpendInput'),
  recommendationPolicyHighSpendInput: document.getElementById('recommendationPolicyHighSpendInput'),
  recommendationPolicyTrendLookbackInput: document.getElementById('recommendationPolicyTrendLookbackInput'),
  recommendationPolicyUptrendRatioInput: document.getElementById('recommendationPolicyUptrendRatioInput'),
  recommendationPolicyDefaultIncreaseRatioInput: document.getElementById('recommendationPolicyDefaultIncreaseRatioInput'),
  recommendationPolicyDefaultDecreaseRatioInput: document.getElementById('recommendationPolicyDefaultDecreaseRatioInput'),
  recommendationPolicyHighSpendIncreaseRatioInput: document.getElementById('recommendationPolicyHighSpendIncreaseRatioInput'),
  recommendationPolicyPromptInput: document.getElementById('recommendationPolicyPromptInput'),
  recommendationPolicyEnabledSelect: document.getElementById('recommendationPolicyEnabledSelect'),
  recommendationPolicyImpactSummary: document.getElementById('recommendationPolicyImpactSummary'),
  recommendationPolicyReviewSummary: document.getElementById('recommendationPolicyReviewSummary'),
  recommendationPolicyPrevBtn: document.getElementById('recommendationPolicyPrevBtn'),
  recommendationPolicyNextBtn: document.getElementById('recommendationPolicyNextBtn'),
  recommendationPolicySaveBtn: document.getElementById('recommendationPolicySaveBtn'),
  recommendationPoliciesTableBody: document.getElementById('recommendationPoliciesTableBody'),

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
  asaKeywordActionItems: document.getElementById('asaKeywordActionItems'),
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
  budgetDetailBudgetAction: document.getElementById('budgetDetailBudgetAction'),
  budgetDetailExecutionActions: document.getElementById('budgetDetailExecutionActions'),
  budgetDetailScenarioTags: document.getElementById('budgetDetailScenarioTags'),
  budgetDetailCurrentCost: document.getElementById('budgetDetailCurrentCost'),
  budgetDetailSuggestedBudget: document.getElementById('budgetDetailSuggestedBudget'),
  budgetDetailChangeRatio: document.getElementById('budgetDetailChangeRatio'),
  budgetDetailExecutionStatus: document.getElementById('budgetDetailExecutionStatus'),
  budgetDetailIsAdopted: document.getElementById('budgetDetailIsAdopted'),
  budgetDetailFeedbackSyncedAt: document.getElementById('budgetDetailFeedbackSyncedAt'),
  budgetDetailValidationResult: document.getElementById('budgetDetailValidationResult'),
  budgetDetailRisk: document.getElementById('budgetDetailRisk'),
  budgetDetailActionItems: document.getElementById('budgetDetailActionItems'),
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

  aiDock: document.getElementById('aiDock'),
  aiDockBackdrop: document.getElementById('aiDockBackdrop'),
  aiDockFabShell: document.getElementById('aiDockFabShell'),
  aiDockToggle: document.getElementById('aiDockToggle'),
  aiDockPanel: document.getElementById('aiDockPanel'),
  aiChatDialog: document.getElementById('aiChatDialog'),
  aiChatBody: document.getElementById('aiChatBody'),
  aiChatCloseBtn: document.getElementById('aiChatCloseBtn'),
  aiChatClearBtn: document.getElementById('aiChatClearBtn'),
  aiChatModelSelect: document.getElementById('aiChatModelSelect'),
  aiChatModelHint: document.getElementById('aiChatModelHint'),
  aiChatContextMenu: document.getElementById('aiChatContextMenu'),
  aiChatRecommendedPacks: document.getElementById('aiChatRecommendedPacks'),
  aiChatCorePacks: document.getElementById('aiChatCorePacks'),
  aiChatMessages: document.getElementById('aiChatMessages'),
  aiChatAttachmentStrip: document.getElementById('aiChatAttachmentStrip'),
  aiChatAttachmentSummary: document.getElementById('aiChatAttachmentSummary'),
  aiChatImageList: document.getElementById('aiChatImageList'),
  aiChatContextPackList: document.getElementById('aiChatContextPackList'),
  aiChatForm: document.getElementById('aiChatForm'),
  aiChatInput: document.getElementById('aiChatInput'),
  aiChatSendBtn: document.getElementById('aiChatSendBtn'),
  aiChatAddImageBtn: document.getElementById('aiChatAddImageBtn'),
  aiChatAddContextBtn: document.getElementById('aiChatAddContextBtn'),
  aiChatImageUploaderInline: document.getElementById('aiChatImageUploaderInline'),
  aiChatFileInput: document.getElementById('aiChatFileInput'),
  aiChatPackTypeSelect: document.getElementById('aiChatPackTypeSelect'),
  aiChatPackTemplateSelect: document.getElementById('aiChatPackTemplateSelect'),
  aiChatPackAppSelect: document.getElementById('aiChatPackAppSelect'),
  aiChatPackPlatformSelect: document.getElementById('aiChatPackPlatformSelect'),
  aiChatPackFromInput: document.getElementById('aiChatPackFromInput'),
  aiChatPackToInput: document.getElementById('aiChatPackToInput'),
  aiChatPackSourceField: document.getElementById('aiChatPackSourceField'),
  aiChatPackSourceSelect: document.getElementById('aiChatPackSourceSelect'),
  aiChatPackMetricField: document.getElementById('aiChatPackMetricField'),
  aiChatPackMetricSelect: document.getElementById('aiChatPackMetricSelect'),
  aiChatPackEventNameField: document.getElementById('aiChatPackEventNameField'),
  aiChatPackEventNameInput: document.getElementById('aiChatPackEventNameInput'),
  aiChatPackStageField: document.getElementById('aiChatPackStageField'),
  aiChatPackStageSelect: document.getElementById('aiChatPackStageSelect'),
  aiChatAttachCustomPackBtn: document.getElementById('aiChatAttachCustomPackBtn'),
  aiChatPackBuilderPreview: document.getElementById('aiChatPackBuilderPreview'),
  aiChatPackBuilderHint: document.getElementById('aiChatPackBuilderHint'),

  toast: document.getElementById('toast')
};

let toastTimer = null;
let scrollTicking = false;
const chartState = new WeakMap();
const helpPopoverGroups = Array.from(document.querySelectorAll('.help-group'));
const AI_CHAT_MODEL_STORAGE_KEY = 'hotspot.aiChat.modelId';
const AI_DOCK_FAB_POSITION_STORAGE_KEY = 'hotspot.aiDock.fabPosition';
const AI_DOCK_DRAG_THRESHOLD_PX = 8;
const AI_DOCK_VIEWPORT_MARGIN_PX = 12;
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

function lockAIDockScroll() {
  if (state.aiChat.scrollLocked) {
    return;
  }
  aiDockScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.classList.add('ai-dock-scroll-locked');
  document.body.style.top = `-${aiDockScrollY}px`;
  state.aiChat.scrollLocked = true;
}

function unlockAIDockScroll() {
  if (!state.aiChat.scrollLocked) {
    return;
  }
  document.body.classList.remove('ai-dock-scroll-locked');
  document.body.style.top = '';
  window.scrollTo(0, aiDockScrollY);
  state.aiChat.scrollLocked = false;
}

function setAIDockInert(open) {
  if (!(el.appShell instanceof HTMLElement)) {
    return;
  }
  if (open) {
    el.appShell.setAttribute('aria-hidden', 'true');
    el.appShell.setAttribute('inert', '');
    return;
  }
  el.appShell.removeAttribute('aria-hidden');
  el.appShell.removeAttribute('inert');
}

function getAIDockFocusableElements() {
  if (!(el.aiDockPanel instanceof HTMLElement)) {
    return [];
  }
  const selectors = [
    'button:not([disabled])',
    '[href]:not([aria-disabled="true"])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ];
  return Array.from(el.aiDockPanel.querySelectorAll(selectors.join(','))).filter(
    (node) => node instanceof HTMLElement && !node.closest('.hidden')
  );
}

function focusAIDockInitialTarget() {
  if (el.aiChatInput instanceof HTMLTextAreaElement) {
    el.aiChatInput.focus();
    return;
  }
  if (el.aiChatDialog instanceof HTMLElement) {
    el.aiChatDialog.focus();
  }
}

function restoreAIDockFocus() {
  if (
    aiDockPreviousFocus instanceof HTMLElement &&
    (document.body?.contains(aiDockPreviousFocus) || document.documentElement.contains(aiDockPreviousFocus))
  ) {
    aiDockPreviousFocus.focus();
  } else if (el.aiDockToggle instanceof HTMLButtonElement) {
    el.aiDockToggle.focus();
  }
}

function handleAIDockFocusTrap(event) {
  if (!state.aiChat.aiDockOpen || event.key !== 'Tab') {
    return;
  }
  const focusable = getAIDockFocusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    el.aiChatDialog?.focus();
    return;
  }
  const currentIndex = focusable.indexOf(document.activeElement);
  if (event.shiftKey) {
    if (currentIndex <= 0) {
      event.preventDefault();
      focusable[focusable.length - 1].focus();
    }
    return;
  }
  if (currentIndex === -1 || currentIndex === focusable.length - 1) {
    event.preventDefault();
    focusable[0].focus();
  }
}

function setAIDockOpen(open) {
  if (!(el.aiDock instanceof HTMLElement) || !(el.aiDockToggle instanceof HTMLButtonElement) || !(el.aiDockPanel instanceof HTMLElement)) {
    return;
  }

  const nextOpen = open === true;
  if (state.aiChat.aiDockOpen === nextOpen) {
    return;
  }

  state.aiChat.aiDockOpen = nextOpen;
  el.aiDock.classList.toggle('is-open', nextOpen);
  el.aiDockPanel.classList.toggle('hidden', !nextOpen);
  el.aiDockBackdrop?.classList.toggle('hidden', !nextOpen);
  el.aiDockPanel.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
  el.aiDockToggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  el.aiDockToggle.setAttribute('aria-label', nextOpen ? '关闭 AI 功能舱' : '打开 AI 功能舱');
  el.aiChatAddContextBtn?.setAttribute('aria-expanded', state.aiChat.contextMenuOpen ? 'true' : 'false');

  if (nextOpen) {
    aiDockPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lockAIDockScroll();
    setAIDockInert(true);
    renderAIChatPackMenus();
    requestAnimationFrame(() => {
      focusAIDockInitialTarget();
      scrollAIChatToBottom(true);
    });
    return;
  }

  setAIChatContextMenuOpen(false);
  unlockAIDockScroll();
  setAIDockInert(false);
  restoreAIDockFocus();
}

function toggleAIDock() {
  setAIDockOpen(!state.aiChat.aiDockOpen);
}

function readStoredAIDockFabPosition() {
  try {
    const raw = String(window.localStorage.getItem(AI_DOCK_FAB_POSITION_STORAGE_KEY) || '').trim();
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    const left = Number(parsed?.left);
    const top = Number(parsed?.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      return null;
    }
    return { left, top };
  } catch {
    return null;
  }
}

function writeStoredAIDockFabPosition(position) {
  try {
    window.localStorage.setItem(
      AI_DOCK_FAB_POSITION_STORAGE_KEY,
      JSON.stringify({
        left: Number(position?.left || 0),
        top: Number(position?.top || 0)
      })
    );
  } catch {
    // ignore storage errors
  }
}

function clampAIDockFabPosition(position) {
  if (!(el.aiDockFabShell instanceof HTMLElement)) {
    return { left: 0, top: 0 };
  }
  const rect = el.aiDockFabShell.getBoundingClientRect();
  const width = Math.max(rect.width || 0, el.aiDockFabShell.offsetWidth || 0, 120);
  const height = Math.max(rect.height || 0, el.aiDockFabShell.offsetHeight || 0, 56);
  const maxLeft = Math.max(AI_DOCK_VIEWPORT_MARGIN_PX, window.innerWidth - width - AI_DOCK_VIEWPORT_MARGIN_PX);
  const maxTop = Math.max(AI_DOCK_VIEWPORT_MARGIN_PX, window.innerHeight - height - AI_DOCK_VIEWPORT_MARGIN_PX);
  return {
    left: Math.min(maxLeft, Math.max(AI_DOCK_VIEWPORT_MARGIN_PX, Number(position?.left || 0))),
    top: Math.min(maxTop, Math.max(AI_DOCK_VIEWPORT_MARGIN_PX, Number(position?.top || 0)))
  };
}

function applyAIDockFabPosition(position, options = {}) {
  if (!(el.aiDockFabShell instanceof HTMLElement)) {
    return;
  }
  if (!position || !Number.isFinite(Number(position.left)) || !Number.isFinite(Number(position.top))) {
    el.aiDockFabShell.style.left = '';
    el.aiDockFabShell.style.top = '';
    el.aiDockFabShell.style.right = '';
    el.aiDockFabShell.style.bottom = '';
    return;
  }
  const next = clampAIDockFabPosition(position);
  el.aiDockFabShell.style.left = `${next.left}px`;
  el.aiDockFabShell.style.top = `${next.top}px`;
  el.aiDockFabShell.style.right = 'auto';
  el.aiDockFabShell.style.bottom = 'auto';
  if (options.persist !== false) {
    writeStoredAIDockFabPosition(next);
  }
}

function restoreAIDockFabPosition() {
  const stored = readStoredAIDockFabPosition();
  if (!stored) {
    return;
  }
  requestAnimationFrame(() => applyAIDockFabPosition(stored));
}

function readCurrentAIDockFabStylePosition() {
  if (!(el.aiDockFabShell instanceof HTMLElement)) {
    return null;
  }
  const left = Number.parseFloat(el.aiDockFabShell.style.left || '');
  const top = Number.parseFloat(el.aiDockFabShell.style.top || '');
  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    return null;
  }
  return { left, top };
}

function refreshAIDockFabPosition() {
  if (!(el.aiDockFabShell instanceof HTMLElement)) {
    return;
  }
  const hasCustomPosition = Boolean(el.aiDockFabShell.style.left && el.aiDockFabShell.style.top);
  if (!hasCustomPosition) {
    return;
  }
  const currentPosition = readCurrentAIDockFabStylePosition();
  if (!currentPosition) {
    return;
  }
  applyAIDockFabPosition(currentPosition);
}

function releaseAIDockPointerCapture(pointerId) {
  if (!(el.aiDockToggle instanceof HTMLElement)) {
    return;
  }
  try {
    if (typeof el.aiDockToggle.hasPointerCapture === 'function' && el.aiDockToggle.hasPointerCapture(pointerId)) {
      el.aiDockToggle.releasePointerCapture(pointerId);
    }
  } catch {
    // ignore release errors
  }
}

function endAIDockDrag(pointerId, options = {}) {
  const dragState = aiDockDragState;
  if (!dragState) {
    return;
  }
  releaseAIDockPointerCapture(pointerId);
  const wasDragging = dragState.dragging === true;
  aiDockDragState = null;
  el.aiDockFabShell?.classList.remove('is-dragging');
  if (wasDragging && el.aiDockFabShell instanceof HTMLElement) {
    const currentPosition = readCurrentAIDockFabStylePosition();
    if (currentPosition) {
      applyAIDockFabPosition(currentPosition);
    }
    aiDockSuppressToggleClick = true;
    window.setTimeout(() => {
      aiDockSuppressToggleClick = false;
    }, 120);
  } else if (options.resetSuppression === true) {
    aiDockSuppressToggleClick = false;
  }
}

function handleAIDockPointerDown(event) {
  if (!(event instanceof PointerEvent)) {
    return;
  }
  if (state.aiChat.aiDockOpen) {
    return;
  }
  if (event.pointerType !== 'touch' && event.button !== 0) {
    return;
  }
  if (!(el.aiDockFabShell instanceof HTMLElement) || !(el.aiDockToggle instanceof HTMLElement)) {
    return;
  }
  const rect = el.aiDockFabShell.getBoundingClientRect();
  aiDockDragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originLeft: rect.left,
    originTop: rect.top,
    dragging: false
  };
  try {
    if (typeof el.aiDockToggle.setPointerCapture === 'function') {
      el.aiDockToggle.setPointerCapture(event.pointerId);
    }
  } catch {
    // ignore capture errors
  }
}

function handleAIDockPointerMove(event) {
  if (!(event instanceof PointerEvent) || !aiDockDragState || aiDockDragState.pointerId !== event.pointerId) {
    return;
  }
  const deltaX = event.clientX - aiDockDragState.startX;
  const deltaY = event.clientY - aiDockDragState.startY;
  if (!aiDockDragState.dragging && Math.hypot(deltaX, deltaY) < AI_DOCK_DRAG_THRESHOLD_PX) {
    return;
  }
  aiDockDragState.dragging = true;
  el.aiDockFabShell?.classList.add('is-dragging');
  event.preventDefault();
  applyAIDockFabPosition(
    {
      left: aiDockDragState.originLeft + deltaX,
      top: aiDockDragState.originTop + deltaY
    },
    { persist: false }
  );
}

function handleAIDockPointerUp(event) {
  if (!(event instanceof PointerEvent) || !aiDockDragState || aiDockDragState.pointerId !== event.pointerId) {
    return;
  }
  endAIDockDrag(event.pointerId, { resetSuppression: true });
}

function handleAIDockPointerCancel(event) {
  if (!(event instanceof PointerEvent) || !aiDockDragState || aiDockDragState.pointerId !== event.pointerId) {
    return;
  }
  endAIDockDrag(event.pointerId, { resetSuppression: true });
}

function parseTriStateBoolean(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function formatFileSize(size) {
  const value = Number(size || 0);
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function aiChatMessageId() {
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getAIChatErrorMessage(code, fallbackMessage = '') {
  if (fallbackMessage) {
    return fallbackMessage;
  }
  if (code === 'ai_chat_timeout') {
    return 'Guru Ads Agent 响应超时，请重试，或减少上下文后再发送。';
  }
  if (code === 'ai_model_unavailable') {
    return 'Guru Ads Agent 当前没有可用模型，请联系管理员检查模型配置。';
  }
  if (code === 'invalid_model_id') {
    return '当前模型无效，请重新选择 Guru Ads Agent 模型。';
  }
  if (code === 'ai_model_images_unsupported') {
    return '当前模型仅支持文本对话，请切回支持图片的模型，或移除图片后再试。';
  }
  if (code === 'openrouter_region_unavailable') {
    return '当前 OpenRouter 的 Kimi-K2.5 在你这个地区或账号下不可用，请先切回 Qwen，或更换可用地区 / 账号后再试。';
  }
  if (code === 'mcp_context_unavailable') {
    return '当前业务数据暂时不可用，请稍后重试，或先直接进行文本对话。';
  }
  if (code === 'internal_error') {
    return 'Guru Ads Agent 暂时不可用，请稍后重试。';
  }
  return '';
}

function readStoredAIChatModelId() {
  try {
    return String(window.localStorage.getItem(AI_CHAT_MODEL_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

function writeStoredAIChatModelId(modelId) {
  try {
    window.localStorage.setItem(AI_CHAT_MODEL_STORAGE_KEY, String(modelId || '').trim());
  } catch {
    // ignore storage errors
  }
}

function clearStoredAIChatModelId() {
  try {
    window.localStorage.removeItem(AI_CHAT_MODEL_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

function getAIChatModelOption(modelId) {
  const normalized = String(modelId || '').trim();
  return (state.aiChat.availableModels || []).find((item) => item.id === normalized) || null;
}

function getAIChatFallbackModel(options = {}) {
  const requiresImages = options.requiresImages === true;
  const excludeModelId = String(options.excludeModelId || '').trim();
  const models = Array.isArray(state.aiChat.availableModels) ? state.aiChat.availableModels : [];
  const filtered = models.filter((item) => {
    if (!item || item.id === excludeModelId) {
      return false;
    }
    if (requiresImages && item.supportsImages === false) {
      return false;
    }
    return true;
  });
  if (filtered.length === 0) {
    return null;
  }
  return filtered.find((item) => item.id === state.aiChat.defaultModelId) || filtered[0];
}

function getAIChatCurrentModelLabel() {
  return getAIChatModelOption(state.aiChat.currentModelId)?.label || '';
}

function buildAIChatModelHintState() {
  const model = getAIChatModelOption(state.aiChat.currentModelId);
  if (!model) {
    return {
      text: '当前没有可用模型。',
      warning: true
    };
  }
  const capabilityParts = [
    model.providerLabel || model.provider || '',
    model.supportsImages === false ? '仅文本' : '支持图片',
    model.supportsThinking ? '支持思考' : '标准响应'
  ].filter(Boolean);
  const hasImages = Array.isArray(state.aiChat.selectedImages) && state.aiChat.selectedImages.length > 0;
  if (hasImages && model.supportsImages === false) {
    return {
      text: `${capabilityParts.join(' · ')}。当前已附带图片，发送时会自动切回支持图片的模型。`,
      warning: true
    };
  }
  return {
    text: capabilityParts.join(' · '),
    warning: false
  };
}

function renderAIChatModelHint() {
  if (!(el.aiChatModelHint instanceof HTMLElement)) {
    return;
  }
  const hintState = buildAIChatModelHintState();
  el.aiChatModelHint.textContent = hintState.text;
  el.aiChatModelHint.classList.toggle('is-warning', hintState.warning);
}

function syncAIChatModelUi() {
  const models = Array.isArray(state.aiChat.availableModels) ? state.aiChat.availableModels : [];
  const hasCurrentModel = models.some((item) => item.id === state.aiChat.currentModelId);
  if (!hasCurrentModel) {
    state.aiChat.currentModelId = models[0]?.id || '';
  }

  if (el.aiChatModelSelect instanceof HTMLSelectElement) {
    if (models.length === 0) {
      el.aiChatModelSelect.innerHTML = '<option value="">当前无可用模型</option>';
      el.aiChatModelSelect.value = '';
    } else {
      el.aiChatModelSelect.innerHTML = models
        .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`)
        .join('');
      el.aiChatModelSelect.value = state.aiChat.currentModelId || models[0].id;
    }
    el.aiChatModelSelect.disabled = state.aiChat.pending || models.length === 0;
  }
  if (el.aiChatSendBtn instanceof HTMLButtonElement) {
    el.aiChatSendBtn.disabled = state.aiChat.pending || !state.aiChat.currentModelId;
  }
  renderAIChatModelHint();
}

function setAIChatModelSelection(modelId, options = {}) {
  const persist = options.persist !== false;
  const match = getAIChatModelOption(modelId);
  state.aiChat.currentModelId = match?.id || '';
  if (persist) {
    if (state.aiChat.currentModelId) {
      writeStoredAIChatModelId(state.aiChat.currentModelId);
    } else {
      clearStoredAIChatModelId();
    }
  }
  syncAIChatModelUi();
}

function createAIChatRequestError(code, message, status) {
  const error = new Error(message || getAIChatErrorMessage(code) || 'Guru Ads Agent 请求失败');
  error.code = code || '';
  error.status = status || 0;
  return error;
}

function maybeFallbackAIChatModelAfterFailure(errorCode, options = {}) {
  const stickyFailureCodes = new Set([
    'ai_model_unavailable',
    'ai_model_images_unsupported',
    'openrouter_region_unavailable'
  ]);
  if (!stickyFailureCodes.has(String(errorCode || ''))) {
    return null;
  }
  const failedModelId = String(options.failedModelId || state.aiChat.currentModelId || '').trim();
  const fallbackModel = getAIChatFallbackModel({
    requiresImages: options.requiresImages === true,
    excludeModelId: failedModelId
  });
  if (!fallbackModel) {
    return null;
  }
  setAIChatModelSelection(fallbackModel.id, { persist: true });
  return fallbackModel;
}

function aiChatPackTemplateLabel(type, templateId) {
  const items = AI_CHAT_PACK_TEMPLATES[type] || [];
  return items.find((item) => item.value === templateId)?.label || templateId;
}

function aiChatPackTypeLabel(type) {
  if (type === 'metrics_trend') return '指标时序';
  if (type === 'budget_summary') return '预算建议';
  if (type === 'asa_keyword_summary') return 'ASA 关键词';
  return type;
}

function aiChatPackKey(spec) {
  return JSON.stringify({
    type: spec.type,
    templateId: spec.templateId,
    appKey: spec.appKey,
    platform: spec.platform || '',
    from: spec.from || '',
    to: spec.to || '',
    source: spec.source || '',
    metric: spec.metric || '',
    eventName: spec.eventName || '',
    status: spec.status || '',
    executionStatus: spec.executionStatus || '',
    isAdopted: typeof spec.isAdopted === 'boolean' ? spec.isAdopted : null,
    hasManualReview: typeof spec.hasManualReview === 'boolean' ? spec.hasManualReview : null,
    stage: spec.stage || '',
    keyword: spec.keyword || '',
    campaign: spec.campaign || ''
  });
}

function aiChatSourceSectionLabel(sectionId) {
  const mapping = {
    'section-overview': '总览看板',
    'section-metrics': '指标看板',
    'section-keywords': '关键词生命周期',
    'section-budget': '预算建议',
    'section-asa-keywords': 'ASA 关键词',
    'section-pull-records': '拉取记录'
  };
  return mapping[String(sectionId || '').trim()] || '当前页面';
}

function aiChatBooleanLabel(value, positive, negative) {
  if (value === true) return positive;
  if (value === false) return negative;
  return '';
}

function aiChatPackQuestionHint(spec) {
  if (spec.type === 'metrics_trend' && spec.templateId === 'media_source') {
    return '最近的量级或成本变化，主要来自哪个媒体源？';
  }
  if (spec.type === 'metrics_trend' && spec.templateId === 'country') {
    return '最近哪些国家在拖累成本，或拉动整体表现？';
  }
  if (spec.type === 'metrics_trend' && spec.templateId === 'campaign') {
    return '最近最值得优先排查的是哪些 campaign？';
  }
  if (spec.type === 'budget_summary' && spec.templateId === 'platform_media_source') {
    return '当前预算建议里，哪些平台或媒体源最值得先处理？';
  }
  if (spec.type === 'budget_summary' && spec.templateId === 'action_status') {
    return '当前建议主要集中在哪些动作和处理状态上？';
  }
  if (spec.type === 'budget_summary' && spec.templateId === 'keyword') {
    return '有哪些关键词是当前最需要关注的预算对象？';
  }
  if (spec.type === 'asa_keyword_summary' && spec.templateId === 'stage') {
    return '当前 ASA 关键词的阶段分布说明了什么问题？';
  }
  if (spec.type === 'asa_keyword_summary' && spec.templateId === 'campaign_adset') {
    return '哪些广告组或 campaign 是当前主要问题来源？';
  }
  return '这份上下文最适合先让模型做一轮面板级概览。';
}

function buildAIChatPackDisplay(spec) {
  const lines = [];
  const payloadParts = [];
  const appName = spec.appKey ? productViewName(spec.appKey, spec.platform || 'unknown') : '';
  const title = `${aiChatPackTypeLabel(spec.type)} · ${aiChatPackTemplateLabel(spec.type, spec.templateId)}`;
  if (appName || spec.appKey) {
    lines.push(appName || spec.appKey);
    payloadParts.push(`应用：${appName || spec.appKey}`);
  }
  if (spec.platform) {
    lines.push(platformLabel(spec.platform));
    payloadParts.push(`平台：${platformLabel(spec.platform)}`);
  } else {
    payloadParts.push('平台：全部平台');
  }
  if (spec.from || spec.to) {
    lines.push(`${spec.from || '不限'} ~ ${spec.to || '不限'}`);
    payloadParts.push(`时间：${spec.from || '不限'} ~ ${spec.to || '不限'}`);
  } else {
    payloadParts.push('时间：沿用当前页面默认窗口');
  }
  if (spec.type === 'metrics_trend' && spec.metric) {
    lines.push(metricLabel(spec.metric));
    payloadParts.push(`指标：${metricLabel(spec.metric)}`);
  }
  if (spec.type === 'metrics_trend' && spec.source) {
    payloadParts.push(`来源：${spec.source === 'push' ? '实时回传' : '广告日报'}`);
  }
  if (spec.type === 'metrics_trend' && spec.eventName) {
    payloadParts.push(`事件：${spec.eventName}`);
  }
  if (spec.type === 'budget_summary' && spec.status) {
    payloadParts.push(`建议状态：${budgetStatusLabel(spec.status)}`);
  }
  if (spec.type === 'budget_summary' && spec.executionStatus) {
    payloadParts.push(`执行状态：${spec.executionStatus}`);
  }
  if (spec.type === 'budget_summary') {
    const adoptedLabel = aiChatBooleanLabel(spec.isAdopted, '已采纳', '未采纳');
    if (adoptedLabel) {
      payloadParts.push(`采纳情况：${adoptedLabel}`);
    }
    const reviewLabel = aiChatBooleanLabel(spec.hasManualReview, '已人工批复', '未人工批复');
    if (reviewLabel) {
      payloadParts.push(`人工批复：${reviewLabel}`);
    }
  }
  if (spec.type === 'asa_keyword_summary' && spec.stage) {
    lines.push(asaStageLabel(spec.stage));
    payloadParts.push(`阶段：${asaStageLabel(spec.stage)}`);
  }
  if (spec.type === 'asa_keyword_summary' && spec.keyword) {
    payloadParts.push(`关键词：${spec.keyword}`);
  }
  if (spec.type === 'asa_keyword_summary' && spec.campaign) {
    payloadParts.push(`Campaign：${spec.campaign}`);
  }
  return {
    title,
    meta: lines.join(' · ') || '当前工作台上下文',
    sourceLabel: `来自当前页面：${aiChatSourceSectionLabel(spec.sourceSection)}`,
    payloadSummary: payloadParts.join('；') || '沿用当前页面的默认应用、平台和时间范围。',
    promptHint: aiChatPackQuestionHint(spec)
  };
}

function compactAIChatSummary(text, maxLength = 220) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function createAIChatLoadedContext(input) {
  if (!input || !input.title || !input.summaryMarkdown) {
    return null;
  }
  return {
    kind: String(input.kind || 'loaded_result').trim(),
    title: String(input.title || '').trim(),
    summary_markdown: String(input.summaryMarkdown || '').trim(),
    applied_filters: input.appliedFilters && typeof input.appliedFilters === 'object' ? { ...input.appliedFilters } : {},
    source_section: String(input.sourceSection || state.activeSection || '').trim() || undefined,
    freshness: String(input.freshness || '').trim() || undefined,
    tool_hint: input.toolHint && typeof input.toolHint === 'object' ? { ...input.toolHint } : undefined
  };
}

function topEntriesFromMap(map, limit = 2) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function buildMetricsLoadedContext() {
  const rows = Array.isArray(state.metricsRows) ? state.metricsRows : [];
  const query = state.metricsQuery && typeof state.metricsQuery === 'object' ? state.metricsQuery : null;
  if (!query || rows.length === 0 || !query.appKey) {
    return [];
  }
  const last = rows.at(-1) || {};
  const previous = rows.length > 1 ? rows.at(-2) || {} : null;
  const latestValue = Number(last.value || 0);
  const previousValue = previous ? Number(previous.value || 0) : null;
  const delta =
    previousValue != null && Number.isFinite(previousValue) && Math.abs(previousValue) > 1e-9
      ? ((latestValue - previousValue) / previousValue) * 100
      : null;
  const summaryLines = [
    `- 应用：${productViewName(query.appKey, query.platform || 'unknown')}`,
    `- 时间范围：${query.from || '不限'} ~ ${query.to || '不限'}`,
    `- 数据来源：${query.source === 'push' ? '实时回传（小时）' : '广告日报（天）'}`,
    `- 指标：${metricLabel(query.metric || 'installs')}`,
    `- 数据点：${rows.length} 个`,
    `- 最新点：${last.hour || last.date || '-'} = ${toFixed2(latestValue)}${delta == null ? '' : `（较上一点 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%）`}`
  ];
  if (query.eventName) {
    summaryLines.splice(4, 0, `- 事件：${query.eventName}`);
  }
  return [
    createAIChatLoadedContext({
      kind: 'metrics_trend',
      title: '当前指标趋势结果',
      summaryMarkdown: summaryLines.join('\n'),
      appliedFilters: {
        appKey: query.appKey,
        platform: query.platform || '',
        from: query.from || '',
        to: query.to || '',
        source: query.source,
        metric: query.metric,
        eventName: query.eventName || ''
      },
      sourceSection: 'section-metrics',
      freshness: state.metricsLoadedAt || undefined,
      toolHint: resolveDefaultMetricsPack({
        appKey: query.appKey,
        platform: query.platform || '',
        from: query.from || '',
        to: query.to || '',
        source: query.source,
        metric: query.metric,
        eventName: query.eventName || '',
        templateId: 'media_source'
      })
    })
  ].filter(Boolean);
}

function buildKeywordLifecycleLoadedContext() {
  const rows = Array.isArray(state.keywordRows) ? state.keywordRows : [];
  const appKey = String(el.keywordAppSelect?.value || '').trim();
  if (!appKey || rows.length === 0) {
    return [];
  }
  const platform = String(el.keywordPlatformSelect?.value || '').trim().toLowerCase();
  const from = String(el.keywordFromInput?.value || '').trim();
  const to = String(el.keywordToInput?.value || '').trim();
  const stage = String(el.keywordStageSelect?.value || '').trim();
  const stageCounts = new Map();
  rows.forEach((row) => {
    const key = String(row.current_stage || 'unknown').trim() || 'unknown';
    stageCounts.set(key, (stageCounts.get(key) || 0) + 1);
  });
  const topStages = topEntriesFromMap(stageCounts, 3)
    .map(([key, count]) => `${lifecycleStageLabel(key)} ${count} 个`)
    .join('，');
  const summaryLines = [
    `- 应用：${productViewName(appKey, platform || 'unknown')}`,
    `- 时间范围：${from || '不限'} ~ ${to || '不限'}`,
    `- 当前关键词生命周期：${rows.length} 条，全部命中 ${state.keywordTotal || rows.length} 条`,
    topStages ? `- 阶段分布：${topStages}` : ''
  ].filter(Boolean);
  if (stage) {
    summaryLines.push(`- 阶段筛选：${lifecycleStageLabel(stage)}`);
  }
  return [
    createAIChatLoadedContext({
      kind: 'keyword_lifecycle',
      title: '当前关键词生命周期结果',
      summaryMarkdown: summaryLines.join('\n'),
      appliedFilters: {
        appKey,
        platform: platform || '',
        from,
        to,
        stage: stage || ''
      },
      sourceSection: 'section-keywords',
      freshness: state.keywordLoadedAt || undefined
    })
  ].filter(Boolean);
}

function buildBudgetLoadedContext() {
  const rows = Array.isArray(state.budgetRows) ? state.budgetRows : [];
  const appKey = String(el.budgetAppSelect?.value || '').trim();
  if (!appKey || rows.length === 0) {
    return [];
  }
  const platform = String(el.budgetPlatformSelect?.value || '').trim().toLowerCase();
  const from = String(el.budgetFromInput?.value || '').trim();
  const to = String(el.budgetToInput?.value || '').trim();
  const status = String(el.budgetStatusSelect?.value || '').trim();
  const executionStatus = String(el.budgetExecutionStatusInput?.value || '').trim();
  const pendingCount = rows.filter((row) => row.status === 'pending').length;
  const adoptedCount = rows.filter((row) => row.is_adopted).length;
  const sourceCounts = new Map();
  rows.forEach((row) => {
    const key = String(row.media_source || 'unknown').trim() || 'unknown';
    sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1);
  });
  const topSources = topEntriesFromMap(sourceCounts, 2)
    .map(([key, count]) => `${key} ${count} 条`)
    .join('，');
  const summaryLines = [
    `- 应用：${productViewName(appKey, platform || 'unknown')}`,
    `- 时间范围：${from || '不限'} ~ ${to || '不限'}`,
    `- 当前列表：${rows.length} 条，全部命中 ${state.budgetTotal || rows.length} 条`,
    `- 待处理：${pendingCount} 条；已采纳：${adoptedCount} 条`,
    topSources ? `- 主要媒体源：${topSources}` : ''
  ].filter(Boolean);
  if (status) {
    summaryLines.push(`- 建议状态筛选：${budgetStatusLabel(status)}`);
  }
  if (executionStatus) {
    summaryLines.push(`- 执行状态筛选：${executionStatus}`);
  }
  return [
    createAIChatLoadedContext({
      kind: 'budget_summary',
      title: '当前预算建议结果',
      summaryMarkdown: summaryLines.join('\n'),
      appliedFilters: {
        appKey,
        platform: platform || '',
        from,
        to,
        status: status || '',
        executionStatus: executionStatus || ''
      },
      sourceSection: 'section-budget',
      freshness: state.budgetLoadedAt || undefined,
      toolHint: resolveBudgetPack({
        appKey,
        platform: platform || '',
        from,
        to,
        status: status || '',
        executionStatus: executionStatus || '',
        templateId: 'platform_media_source'
      })
    })
  ].filter(Boolean);
}

function buildAsaLoadedContext() {
  const rows = Array.isArray(state.asaKeywordRows) ? state.asaKeywordRows : [];
  const summary = state.asaSummary && typeof state.asaSummary === 'object' ? state.asaSummary : {};
  const appKey = String(el.asaKeywordAppSelect?.value || '').trim();
  if (!appKey || rows.length === 0) {
    return [];
  }
  const platform = String(el.asaKeywordPlatformSelect?.value || '').trim().toLowerCase();
  const stage = String(el.asaKeywordStageSelect?.value || '').trim();
  const from = String(el.asaKeywordFromInput?.value || '').trim();
  const to = String(el.asaKeywordToInput?.value || '').trim();
  const stageCounts = new Map();
  rows.forEach((row) => {
    const key = String(row.current_stage || 'unknown').trim() || 'unknown';
    stageCounts.set(key, (stageCounts.get(key) || 0) + 1);
  });
  const topStages = topEntriesFromMap(stageCounts, 3)
    .map(([key, count]) => `${asaStageLabel(key)} ${count} 个`)
    .join('，');
  const summaryLines = [
    `- 应用：${productViewName(appKey, platform || 'unknown')}`,
    `- 时间范围：${from || '不限'} ~ ${to || '不限'}`,
    `- 当前关键词：${rows.length} 条，汇总关键词数 ${summary.keyword_count || rows.length}`,
    `- 安装：${toFixed2(summary.installs || 0)}；成本：$${toFixed2(summary.total_cost || 0)}`,
    topStages ? `- 阶段分布：${topStages}` : ''
  ].filter(Boolean);
  if (stage) {
    summaryLines.push(`- 阶段筛选：${asaStageLabel(stage)}`);
  }
  return [
    createAIChatLoadedContext({
      kind: 'asa_keyword_summary',
      title: '当前 ASA 关键词结果',
      summaryMarkdown: summaryLines.join('\n'),
      appliedFilters: {
        appKey,
        platform: platform || '',
        from,
        to,
        stage: stage || ''
      },
      sourceSection: 'section-asa-keywords',
      freshness: state.asaKeywordsLoadedAt || undefined,
      toolHint: resolveAsaPack({
        appKey,
        platform: platform || '',
        from,
        to,
        stage: stage || '',
        templateId: 'stage'
      })
    })
  ].filter(Boolean);
}

function buildPullRecordsLoadedContext() {
  const rows = Array.isArray(state.pullRecords) ? state.pullRecords : [];
  const appKey = String(el.pullRecordsAppSelect?.value || '').trim();
  if (!appKey || rows.length === 0) {
    return [];
  }
  const platform = String(el.pullRecordsPlatformSelect?.value || '').trim().toLowerCase();
  const from = String(el.pullRecordsFromInput?.value || '').trim();
  const to = String(el.pullRecordsToInput?.value || '').trim();
  const mediaSource = String(el.pullRecordsMediaSourceInput?.value || '').trim();
  const campaign = String(el.pullRecordsCampaignInput?.value || '').trim();
  const totalInstalls = rows.reduce((sum, row) => sum + Number(row.installs || 0), 0);
  const totalCost = rows.reduce((sum, row) => sum + Number(row.total_cost || 0), 0);
  const sourceCounts = new Map();
  rows.forEach((row) => {
    const key = String(row.media_source || 'unknown').trim() || 'unknown';
    sourceCounts.set(key, (sourceCounts.get(key) || 0) + Number(row.installs || 0));
  });
  const topSources = topEntriesFromMap(sourceCounts, 2)
    .map(([key, installs]) => `${key} ${toFixed2(installs)} 安装`)
    .join('，');
  const summaryLines = [
    `- 应用：${productViewName(appKey, platform || 'unknown')}`,
    `- 时间范围：${from || '不限'} ~ ${to || '不限'}`,
    `- 当前拉取记录：${rows.length} 条，安装 ${toFixed2(totalInstalls)}，成本 $${toFixed2(totalCost)}`,
    topSources ? `- 主要来源：${topSources}` : ''
  ].filter(Boolean);
  if (mediaSource) {
    summaryLines.push(`- 媒体源筛选：${mediaSource}`);
  }
  if (campaign) {
    summaryLines.push(`- Campaign 筛选：${campaign}`);
  }
  return [
    createAIChatLoadedContext({
      kind: 'pull_records',
      title: '当前拉取记录结果',
      summaryMarkdown: summaryLines.join('\n'),
      appliedFilters: {
        appKey,
        platform: platform || '',
        from,
        to,
        source: 'pull',
        mediaSource: mediaSource || '',
        campaign: campaign || ''
      },
      sourceSection: 'section-pull-records',
      freshness: state.pullRecordsLoadedAt || undefined,
      toolHint: resolveDefaultMetricsPack({
        appKey,
        platform: platform || '',
        from,
        to,
        source: 'pull',
        metric: 'installs',
        templateId: 'campaign'
      })
    })
  ].filter(Boolean);
}

function buildDailyBriefLoadedContext() {
  const payload = state.dailyBriefPreviewPayload;
  if (!payload || !(el.dailyBriefModal instanceof HTMLElement) || el.dailyBriefModal.classList.contains('hidden')) {
    return [];
  }
  const report = payload.report || payload || {};
  const summary = report.summary || {};
  const actionCount = Array.isArray(report.action_items) ? report.action_items.length : 0;
  return [
    createAIChatLoadedContext({
      kind: 'daily_brief_preview',
      title: '当前每日简报预览',
      summaryMarkdown: [
        `- 报告日期：${report.report_date || '-'}`,
        `- 产品覆盖：${summary.apps_with_data || 0}/${summary.app_count || 0}`,
        `- 安装：${toFixed2(summary.total_installs || 0)}；成本：$${toFixed2(summary.total_cost || 0)}`,
        `- 待处理预算：${summary.pending_budget_actions || 0}；建议动作：${actionCount}`,
        `- 今日判断：${compactAIChatSummary(report.today_judgment || '暂无判断', 140)}`
      ].join('\n'),
      appliedFilters: {
        reportDate: String(report.report_date || '').trim(),
        renderMode: String(report.render_mode || '').trim()
      },
      sourceSection: 'section-overview',
      freshness: state.dailyBriefPreviewLoadedAt || undefined
    })
  ].filter(Boolean);
}

function buildAsaBriefLoadedContext() {
  const payload = state.asaBriefPreviewPayload;
  if (!payload || !(el.asaBriefModal instanceof HTMLElement) || el.asaBriefModal.classList.contains('hidden')) {
    return [];
  }
  const report = payload.report || payload || {};
  const summary = report.summary || {};
  const actionCount = Array.isArray(report.action_rows) ? report.action_rows.length : 0;
  return [
    createAIChatLoadedContext({
      kind: 'asa_brief_preview',
      title: '当前 ASA 简报预览',
      summaryMarkdown: [
        `- 报告日期：${report.report_date || '-'}`,
        `- 当前阶段：${asaStageLabel(report.current_stage)}`,
        `- 关键词数：${summary.keyword_count || 0}；安装：${toFixed2(summary.installs || 0)}；成本：$${toFixed2(summary.total_cost || 0)}`,
        `- 建议动作：${actionCount}`,
        `- 今日判断：${compactAIChatSummary(report.today_judgment || '暂无判断', 140)}`
      ].join('\n'),
      appliedFilters: {
        reportDate: String(report.report_date || '').trim(),
        currentStage: String(report.current_stage || '').trim()
      },
      sourceSection: 'section-overview',
      freshness: state.asaBriefPreviewLoadedAt || undefined
    })
  ].filter(Boolean);
}

function buildAIChatLoadedContexts() {
  const modalContexts = [...buildDailyBriefLoadedContext(), ...buildAsaBriefLoadedContext()];
  if (modalContexts.length > 0) {
    return modalContexts;
  }
  if (state.activeSection === 'section-metrics') {
    return buildMetricsLoadedContext();
  }
  if (state.activeSection === 'section-keywords') {
    return buildKeywordLifecycleLoadedContext();
  }
  if (state.activeSection === 'section-budget') {
    return buildBudgetLoadedContext();
  }
  if (state.activeSection === 'section-asa-keywords') {
    return buildAsaLoadedContext();
  }
  if (state.activeSection === 'section-pull-records') {
    return buildPullRecordsLoadedContext();
  }
  return [];
}

function isAIChatNearBottom() {
  if (!(el.aiChatMessages instanceof HTMLElement)) {
    return true;
  }
  const threshold = 96;
  return el.aiChatMessages.scrollHeight - el.aiChatMessages.scrollTop - el.aiChatMessages.clientHeight <= threshold;
}

function scrollAIChatToBottom(force = false) {
  if (!(el.aiChatMessages instanceof HTMLElement)) {
    return;
  }
  if (!force && !isAIChatNearBottom()) {
    return;
  }
  requestAnimationFrame(() => {
    el.aiChatMessages.scrollTop = el.aiChatMessages.scrollHeight;
  });
}

function syncAIChatAccordionState() {
  if (!(el.aiChatContextMenu instanceof HTMLElement)) {
    return;
  }
  const activeFold = el.aiChatContextMenu.querySelector('.ai-chat-fold[open]');
  if (activeFold instanceof HTMLDetailsElement) {
    state.aiChat.activeToolSection = String(activeFold.dataset.aiToolSection || 'database');
    const activeSubfold = activeFold.querySelector('.ai-chat-subfold[open]');
    state.aiChat.activeToolSubsection = String(activeSubfold?.dataset.aiToolSubsection || '');
  }
}

function ensureAIChatDefaultAccordionState() {
  if (!(el.aiChatContextMenu instanceof HTMLElement)) {
    return;
  }
  const folds = Array.from(el.aiChatContextMenu.querySelectorAll('.ai-chat-fold'));
  const openFold = folds.find((item) => item instanceof HTMLDetailsElement && item.open);
  if (!openFold && folds[0] instanceof HTMLDetailsElement) {
    folds[0].open = true;
  }
  const activeFold = folds.find((item) => item instanceof HTMLDetailsElement && item.open);
  if (!(activeFold instanceof HTMLDetailsElement)) {
    return;
  }
  const subfolds = Array.from(activeFold.querySelectorAll('.ai-chat-subfold'));
  const openSubfold = subfolds.find((item) => item instanceof HTMLDetailsElement && item.open);
  if (!openSubfold && subfolds[0] instanceof HTMLDetailsElement) {
    subfolds[0].open = true;
  }
  syncAIChatAccordionState();
}

function setAIChatContextMenuOpen(open) {
  state.aiChat.contextMenuOpen = open === true;
  if (!(el.aiChatContextMenu instanceof HTMLElement)) {
    return;
  }
  el.aiChatDialog?.classList.toggle('has-context-open', state.aiChat.contextMenuOpen);
  el.aiChatContextMenu.classList.toggle('hidden', !state.aiChat.contextMenuOpen);
  el.aiChatAddContextBtn?.setAttribute('aria-expanded', state.aiChat.contextMenuOpen ? 'true' : 'false');
  if (state.aiChat.contextMenuOpen) {
    ensureAIChatDefaultAccordionState();
    renderAIChatPackMenus();
    requestAnimationFrame(() => {
      el.aiChatBody?.scrollTo({ top: 0, behavior: 'auto' });
      el.aiChatMessages?.scrollTo({ top: 0, behavior: 'auto' });
    });
  }
}

function getAIChatMetricOptions(source) {
  return source === 'push' ? PUSH_METRIC_OPTIONS : PULL_METRIC_OPTIONS;
}

function syncAIChatPackMetricOptions() {
  if (!(el.aiChatPackSourceSelect instanceof HTMLSelectElement) || !(el.aiChatPackMetricSelect instanceof HTMLSelectElement)) {
    return;
  }
  const items = getAIChatMetricOptions(el.aiChatPackSourceSelect.value || 'pull');
  const currentValue = String(el.aiChatPackMetricSelect.value || '').trim();
  el.aiChatPackMetricSelect.innerHTML = items
    .map((item) => `<option value="${item.value}">${item.label}</option>`)
    .join('');
  if (items.some((item) => item.value === currentValue)) {
    el.aiChatPackMetricSelect.value = currentValue;
  }
}

function syncAIChatContextBuilderVisibility() {
  if (
    !(el.aiChatPackTypeSelect instanceof HTMLSelectElement) ||
    !(el.aiChatPackTemplateSelect instanceof HTMLSelectElement) ||
    !(el.aiChatPackBuilderHint instanceof HTMLElement)
  ) {
    return;
  }
  const type = el.aiChatPackTypeSelect.value || 'metrics_trend';
  const templates = AI_CHAT_PACK_TEMPLATES[type] || AI_CHAT_PACK_TEMPLATES.metrics_trend;
  const templateValue = String(el.aiChatPackTemplateSelect.value || '').trim();
  el.aiChatPackTemplateSelect.innerHTML = templates
    .map((item) => `<option value="${item.value}">${item.label}</option>`)
    .join('');
  if (templates.some((item) => item.value === templateValue)) {
    el.aiChatPackTemplateSelect.value = templateValue;
  }

  const isMetrics = type === 'metrics_trend';
  const isAsa = type === 'asa_keyword_summary';
  el.aiChatPackSourceField?.classList.toggle('hidden', !isMetrics);
  el.aiChatPackMetricField?.classList.toggle('hidden', !isMetrics);
  el.aiChatPackStageField?.classList.toggle('hidden', !isAsa);
  syncAIChatPackMetricOptions();
  const isEventCount = isMetrics && (el.aiChatPackMetricSelect?.value || '') === 'event_count';
  const isPush = isMetrics && (el.aiChatPackSourceSelect?.value || '') === 'push';
  el.aiChatPackEventNameField?.classList.toggle('hidden', !(isPush && isEventCount));

  const hint =
    type === 'metrics_trend'
      ? '生成按媒体源 / 国家 / 活动的趋势聚合，不上传原始时序明细。'
      : type === 'budget_summary'
        ? '生成预算建议分布、状态与 Top 聚合摘要，不上传逐条 recommendation 原文。'
        : '生成 ASA 关键词阶段或广告组级摘要，聚焦 7 日表现与动作分布。';
  el.aiChatPackBuilderHint.textContent = hint;
  syncAIChatPackBuilderPreview();
}

function syncAIChatPackBuilderPreview() {
  if (!(el.aiChatPackBuilderPreview instanceof HTMLElement)) {
    return;
  }
  try {
    const spec = buildCustomAIChatPackSpec();
    const display = buildAIChatPackDisplay(spec);
    el.aiChatPackBuilderPreview.textContent = `即将附加：${display.title}｜${display.payloadSummary}｜适合问：${display.promptHint}`;
  } catch (error) {
    el.aiChatPackBuilderPreview.textContent = '先选择应用、模板和时间范围，再附加自定义数据包。';
  }
}

function syncAIChatInputHeight() {
  if (!(el.aiChatInput instanceof HTMLTextAreaElement)) {
    return;
  }
  el.aiChatInput.style.height = 'auto';
  const nextHeight = Math.min(el.aiChatInput.scrollHeight, 152);
  el.aiChatInput.style.height = `${Math.max(nextHeight, 56)}px`;
}

function renderAIChatMessageAttachments(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '';
  }
  return `<div class="ai-chat-message-attachments">${items
    .map((item) => `<span class="ai-chat-message-chip">${escapeHtml(item.title || item.name || '附件')}</span>`)
    .join('')}</div>`;
}

function renderAIChatMessageToolTrace(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '';
  }
  return `
    <div class="ai-chat-message-trace">
      <span class="ai-chat-message-trace-label">已自动查询</span>
      <div class="ai-chat-message-attachments">
        ${items
          .map((item) => {
            const title = String(item.title || '').trim();
            const brief = String(item.brief || '').trim();
            const text = brief ? `${title}｜${brief}` : title || '工具结果';
            return `<span class="ai-chat-message-chip">${escapeHtml(text)}</span>`;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderAIChatMessagePageTrace(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '';
  }
  return `
    <div class="ai-chat-message-trace">
      <span class="ai-chat-message-trace-label">已附加当前页面结果</span>
      <div class="ai-chat-message-attachments">
        ${items
          .map((item) => {
            const title = String(item.title || '').trim();
            const brief = String(item.brief || '').trim();
            const text = brief ? `${title}｜${brief}` : title || '当前页面结果';
            return `<span class="ai-chat-message-chip">${escapeHtml(text)}</span>`;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderAIChatMessages() {
  if (!(el.aiChatMessages instanceof HTMLElement)) {
    return;
  }
  const shouldStick = isAIChatNearBottom();
  const rows = Array.isArray(state.aiChat.messages) ? state.aiChat.messages : [];
  if (rows.length === 0) {
    const loadedContexts = buildAIChatLoadedContexts();
    const loadedContextSummary =
      loadedContexts.length > 0
        ? loadedContexts
            .slice(0, 2)
            .map((item) => {
              const filters = item.applied_filters || {};
              const detail = [
                String(filters.appKey || '').trim(),
                filters.from || filters.to ? `${filters.from || '不限'}~${filters.to || '不限'}` : '',
                String(item.title || '').trim()
              ]
                .filter(Boolean)
                .join(' / ');
              return `<span class="ai-chat-message-chip">${escapeHtml(detail || item.title || '当前页面结果')}</span>`;
            })
            .join('')
        : '';
    el.aiChatMessages.innerHTML = `
      <div class="ai-chat-empty">
        <p>开始对话...(*´∀&#96;)~♥</p>
        ${
          loadedContextSummary
            ? `<div class="ai-chat-message-trace">
                <span class="ai-chat-message-trace-label">当前已识别页面结果</span>
                <div class="ai-chat-message-attachments">${loadedContextSummary}</div>
              </div>`
            : ''
        }
      </div>
    `;
    scrollAIChatToBottom(true);
    return;
  }
  el.aiChatMessages.innerHTML = rows
    .map((item) => {
      const isClarification = item.role === 'assistant' && item.meta?.agentAction === 'clarification';
      const roleClass = item.role === 'user' ? 'is-user' : isClarification || item.role === 'system' ? 'is-system' : 'is-assistant';
      const roleLabel = item.role === 'user' ? '你' : isClarification ? '系统追问' : item.role === 'system' ? '系统提示' : 'Guru Ads Agent';
      const modelLabel = item.role === 'assistant' ? String(item.modelLabel || '').trim() : '';
      const metaPrefix = [roleLabel, modelLabel].filter(Boolean).join(' · ');
      const metaText = item.pending ? `${metaPrefix} · 正在生成…` : `${metaPrefix} · ${fmtTime(item.createdAt)}`;
      const bubble = renderAIChatMessageBubble(item);
      return `
        <div class="ai-chat-message ${roleClass}">
          <div class="ai-chat-message-meta">${escapeHtml(metaText)}</div>
          <div class="ai-chat-message-bubble ${bubble.bubbleClass}">${bubble.bubbleHtml}</div>
          ${renderAIChatMessagePageTrace(item.pageTrace)}
          ${renderAIChatMessageToolTrace(item.toolTrace)}
          ${renderAIChatMessageAttachments(item.attachments)}
        </div>
      `;
    })
    .join('');
  scrollAIChatToBottom(shouldStick);
}

function revokeAIChatImagePreview(image) {
  if (image && typeof image.previewUrl === 'string' && image.previewUrl.startsWith('blob:')) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

function renderAIChatAttachmentStrip() {
  if (
    !(el.aiChatAttachmentStrip instanceof HTMLElement) ||
    !(el.aiChatAttachmentSummary instanceof HTMLElement) ||
    !(el.aiChatImageList instanceof HTMLElement) ||
    !(el.aiChatContextPackList instanceof HTMLElement)
  ) {
    return;
  }
  const images = Array.isArray(state.aiChat.selectedImages) ? state.aiChat.selectedImages : [];
  const packs = Array.isArray(state.aiChat.selectedContextPacks) ? state.aiChat.selectedContextPacks : [];
  const hasAttachments = images.length > 0 || packs.length > 0;
  el.aiChatAttachmentStrip.classList.toggle('hidden', !hasAttachments);
  if (hasAttachments) {
    const summaryParts = [];
    if (packs.length > 0) {
      summaryParts.push(`数据包 ${packs.length} 个：${packs.map((item) => `${item.title}（${item.meta}）`).join('；')}`);
    }
    if (images.length > 0) {
      summaryParts.push(`图片 ${images.length} 张`);
    }
    el.aiChatAttachmentSummary.textContent = `本次发送会附带：${summaryParts.join('；')}`;
  } else {
    el.aiChatAttachmentSummary.textContent = '';
  }
  el.aiChatImageList.innerHTML = images
    .map(
      (item) => `
        <div class="ai-chat-chip">
          <img class="ai-chat-chip-preview" src="${escapeHtml(item.previewUrl)}" alt="${escapeHtml(item.file.name)}" />
          <span class="ai-chat-chip-copy">
            <strong>${escapeHtml(item.file.name)}</strong>
            <small>${escapeHtml(formatFileSize(item.file.size))}</small>
          </span>
          <button class="ai-chat-chip-remove" type="button" data-ai-chat-image-remove="${escapeHtml(item.id)}">×</button>
        </div>
      `
    )
    .join('');
  el.aiChatContextPackList.innerHTML = packs
    .map(
      (item) => `
        <div class="ai-chat-chip">
          <span class="ai-chat-chip-copy">
            <strong>${escapeHtml(item.title)}</strong>
            <small>${escapeHtml(item.meta)}</small>
          </span>
          <button class="ai-chat-chip-remove" type="button" data-ai-chat-pack-remove="${escapeHtml(item.key)}">×</button>
        </div>
      `
    )
    .join('');
  renderAIChatModelHint();
}

function clearAIChatAttachments() {
  (state.aiChat.selectedImages || []).forEach((item) => revokeAIChatImagePreview(item));
  state.aiChat.selectedImages = [];
  state.aiChat.selectedContextPacks = [];
  if (el.aiChatFileInput instanceof HTMLInputElement) {
    el.aiChatFileInput.value = '';
  }
  renderAIChatAttachmentStrip();
}

function removeAIChatImage(id) {
  const next = [];
  for (const item of state.aiChat.selectedImages || []) {
    if (item.id === id) {
      revokeAIChatImagePreview(item);
      continue;
    }
    next.push(item);
  }
  state.aiChat.selectedImages = next;
  renderAIChatAttachmentStrip();
}

function removeAIChatContextPack(key) {
  state.aiChat.selectedContextPacks = (state.aiChat.selectedContextPacks || []).filter((item) => item.key !== key);
  renderAIChatAttachmentStrip();
}

function resolveDefaultMetricsPack(overrides = {}) {
  const now = new Date();
  const source = String(overrides.source || el.metricsSourceSelect?.value || 'pull').trim();
  const to = toLocalDate(now);
  const from = toLocalDate(new Date(now.getTime() - (source === 'push' ? 2 : 13) * 24 * 60 * 60 * 1000));
  return {
    type: 'metrics_trend',
    templateId: overrides.templateId || 'media_source',
    appKey: String(overrides.appKey || el.metricsAppSelect?.value || state.apps[0]?.app_key || '').trim(),
    platform: String(overrides.platform || el.metricsPlatformSelect?.value || '').trim().toLowerCase() || undefined,
    from: String(overrides.from || from),
    to: String(overrides.to || to),
    source,
    metric: String(overrides.metric || el.metricsMetricSelect?.value || (source === 'push' ? 'revenue' : 'installs')).trim(),
    eventName: String(overrides.eventName || el.metricsEventNameInput?.value || '').trim() || undefined,
    sourceSection: state.activeSection
  };
}

function resolveBudgetPack(overrides = {}) {
  const form = el.budgetFilter instanceof HTMLFormElement ? new FormData(el.budgetFilter) : new FormData();
  return {
    type: 'budget_summary',
    templateId: overrides.templateId || 'platform_media_source',
    appKey: String(overrides.appKey || form.get('appKey') || state.apps[0]?.app_key || '').trim(),
    platform: String(overrides.platform || form.get('platform') || '').trim().toLowerCase() || undefined,
    from: String(overrides.from || form.get('from') || '').trim() || undefined,
    to: String(overrides.to || form.get('to') || '').trim() || undefined,
    status: String(overrides.status || form.get('status') || '').trim() || undefined,
    executionStatus: String(overrides.executionStatus || form.get('executionStatus') || '').trim() || undefined,
    isAdopted:
      typeof overrides.isAdopted === 'boolean' ? overrides.isAdopted : parseTriStateBoolean(form.get('isAdopted')),
    hasManualReview:
      typeof overrides.hasManualReview === 'boolean'
        ? overrides.hasManualReview
        : parseTriStateBoolean(form.get('hasManualReview')),
    sourceSection: state.activeSection
  };
}

function resolveAsaPack(overrides = {}) {
  const form = el.asaKeywordFilter instanceof HTMLFormElement ? new FormData(el.asaKeywordFilter) : new FormData();
  return {
    type: 'asa_keyword_summary',
    templateId: overrides.templateId || 'stage',
    appKey: String(overrides.appKey || form.get('appKey') || state.apps[0]?.app_key || '').trim(),
    platform: String(overrides.platform || form.get('platform') || '').trim().toLowerCase() || undefined,
    from: String(overrides.from || form.get('from') || '').trim() || undefined,
    to: String(overrides.to || form.get('to') || '').trim() || undefined,
    stage: String(overrides.stage || form.get('stage') || '').trim() || undefined,
    keyword: String(overrides.keyword || form.get('keyword') || '').trim() || undefined,
    campaign: String(overrides.campaign || form.get('campaign') || '').trim() || undefined,
    sourceSection: state.activeSection
  };
}

function createAIChatPackCard(spec, meta, desc) {
  const info = buildAIChatPackDisplay(spec);
  return {
    spec,
    title: info.title,
    meta: info.meta,
    sourceLabel: meta ? `${meta} · ${info.sourceLabel}` : info.sourceLabel,
    payloadSummary: info.payloadSummary,
    promptHint: desc || info.promptHint,
    disabled: !spec.appKey
  };
}

function buildRecommendedAIChatPackCards() {
  if (state.activeSection === 'section-metrics') {
    return [
      createAIChatPackCard(resolveDefaultMetricsPack({ templateId: 'media_source' }), '当前指标面板', '最适合追问最近波动来自哪个媒体源。'),
      createAIChatPackCard(resolveDefaultMetricsPack({ templateId: 'country' }), '当前指标面板', '快速查看地域维度是否出现结构性异常。')
    ];
  }
  if (state.activeSection === 'section-budget') {
    return [
      createAIChatPackCard(resolveBudgetPack({ templateId: 'platform_media_source' }), '当前预算筛选', '把预算建议按平台与媒体源重新聚合给模型。'),
      createAIChatPackCard(resolveBudgetPack({ templateId: 'action_status' }), '当前预算筛选', '适合追问哪些动作类型最需要优先处理。')
    ];
  }
  if (state.activeSection === 'section-asa-keywords') {
    return [
      createAIChatPackCard(resolveAsaPack({ templateId: 'stage' }), '当前 ASA 筛选', '先看 rising / stable 等阶段分布。'),
      createAIChatPackCard(resolveAsaPack({ templateId: 'campaign_adset' }), '当前 ASA 筛选', '快速聚焦广告组层面的重点包。')
    ];
  }
  if (state.activeSection === 'section-pull-records') {
    return [
      createAIChatPackCard(resolveDefaultMetricsPack({ source: 'pull', templateId: 'campaign' }), '广告日报视角', '把最近拉取日报按 campaign 聚合附带给模型。'),
      createAIChatPackCard(resolveBudgetPack({ templateId: 'platform_media_source' }), '预算建议联动', '顺手串联预算建议，看是否和日报趋势一致。')
    ];
  }
  return [
    createAIChatPackCard(resolveDefaultMetricsPack({ templateId: 'media_source' }), '默认推荐', '先用指标时序概览当前流量和成本。'),
    createAIChatPackCard(resolveBudgetPack({ templateId: 'platform_media_source' }), '默认推荐', '快速附带预算建议整体分布。')
  ];
}

function buildCoreAIChatPackCards() {
  return [
    createAIChatPackCard(resolveDefaultMetricsPack({ templateId: 'media_source' }), '核心包', '指标时序默认按媒体源聚合。'),
    createAIChatPackCard(resolveBudgetPack({ templateId: 'platform_media_source' }), '核心包', '预算建议默认按平台 / 媒体源聚合。'),
    createAIChatPackCard(resolveAsaPack({ templateId: 'stage' }), '核心包', 'ASA 默认按阶段聚合。')
  ];
}

function buildAIChatPageContext() {
  const recommendedCards = buildRecommendedAIChatPackCards().filter((card) => card && card.spec && card.spec.appKey);
  const coreCards = buildCoreAIChatPackCards().filter((card) => card && card.spec && card.spec.appKey);
  const loadedContexts = buildAIChatLoadedContexts().filter(Boolean);
  const primarySpec =
    loadedContexts[0]?.tool_hint ||
    recommendedCards[0]?.spec ||
    coreCards[0]?.spec ||
    resolveDefaultMetricsPack({ templateId: 'media_source' });

  const defaults = {
    appKey: String(primarySpec.appKey || '').trim() || undefined,
    platform: String(primarySpec.platform || '').trim() || undefined,
    from: String(primarySpec.from || '').trim() || undefined,
    to: String(primarySpec.to || '').trim() || undefined
  };

  const currentFilters = {};
  if (primarySpec.source) currentFilters.source = primarySpec.source;
  if (primarySpec.metric) currentFilters.metric = primarySpec.metric;
  if (primarySpec.eventName) currentFilters.eventName = primarySpec.eventName;
  if (primarySpec.status) currentFilters.status = primarySpec.status;
  if (primarySpec.executionStatus) currentFilters.executionStatus = primarySpec.executionStatus;
  if (typeof primarySpec.isAdopted === 'boolean') currentFilters.isAdopted = primarySpec.isAdopted;
  if (typeof primarySpec.hasManualReview === 'boolean') currentFilters.hasManualReview = primarySpec.hasManualReview;
  if (primarySpec.stage) currentFilters.stage = primarySpec.stage;
  if (primarySpec.keyword) currentFilters.keyword = primarySpec.keyword;
  if (primarySpec.campaign) currentFilters.campaign = primarySpec.campaign;

  return {
    activeSection: state.activeSection,
    pageLabel: aiChatSourceSectionLabel(state.activeSection),
    defaults,
    currentFilters,
    loaded_contexts: loadedContexts,
    recommendedSpecs: recommendedCards.map((card) => ({ ...card.spec })),
    coreSpecs: coreCards.map((card) => ({ ...card.spec }))
  };
}

function renderAIChatPackCards(container, cards, role) {
  if (!(container instanceof HTMLElement)) {
    return;
  }
  container.innerHTML = cards
    .map((card, index) => {
      const payload = encodeURIComponent(JSON.stringify(card.spec));
      const badgeText = role === 'recommended' ? (index === 0 ? '首选' : '备选') : role === 'core' ? '固定' : '模板';
      return `
        <button
          class="ai-chat-pack-card"
          type="button"
          data-ai-chat-pack-role="${escapeHtml(role)}"
          data-ai-chat-pack-spec="${payload}"
          ${card.disabled ? 'disabled' : ''}
        >
          <span class="ai-chat-pack-card-title">
            <span>${escapeHtml(card.title)}</span>
            <span class="badge badge-open">${escapeHtml(badgeText)}</span>
          </span>
          <span class="ai-chat-pack-card-meta">${escapeHtml(card.sourceLabel || card.meta || '当前上下文')}</span>
          <span class="ai-chat-pack-card-block">
            <span class="ai-chat-pack-card-label">本次会附加</span>
            <span class="ai-chat-pack-card-body">${escapeHtml(card.payloadSummary || card.meta || '当前页面上下文')}</span>
          </span>
          <span class="ai-chat-pack-card-block">
            <span class="ai-chat-pack-card-label">适合提问</span>
            <span class="ai-chat-pack-card-body">${escapeHtml(card.promptHint || '先让模型基于当前页面做一轮概览。')}</span>
          </span>
        </button>
      `;
    })
    .join('');
}

function renderAIChatPackMenus() {
  renderAIChatPackCards(el.aiChatRecommendedPacks, buildRecommendedAIChatPackCards(), 'recommended');
  renderAIChatPackCards(el.aiChatCorePacks, buildCoreAIChatPackCards(), 'core');
}

function addAIChatContextPack(spec) {
  if (!spec.appKey) {
    throw new Error('请先选择应用，再附加数据包。');
  }
  const key = aiChatPackKey(spec);
  if ((state.aiChat.selectedContextPacks || []).some((item) => item.key === key)) {
    showToast('这个数据包已经在待发送列表里');
    return;
  }
  if ((state.aiChat.selectedContextPacks || []).length >= 3) {
    throw new Error('单次最多附加 3 个数据库聚合包');
  }
  const display = buildAIChatPackDisplay(spec);
  state.aiChat.selectedContextPacks = [...(state.aiChat.selectedContextPacks || []), { key, spec, ...display }];
  renderAIChatAttachmentStrip();
  setAIChatContextMenuOpen(false);
  showToast(`已附加 ${display.title}：${display.meta}`);
}

function buildCustomAIChatPackSpec() {
  if (
    !(el.aiChatPackTypeSelect instanceof HTMLSelectElement) ||
    !(el.aiChatPackTemplateSelect instanceof HTMLSelectElement) ||
    !(el.aiChatPackAppSelect instanceof HTMLSelectElement) ||
    !(el.aiChatPackPlatformSelect instanceof HTMLSelectElement) ||
    !(el.aiChatPackFromInput instanceof HTMLInputElement) ||
    !(el.aiChatPackToInput instanceof HTMLInputElement)
  ) {
    throw new Error('AI 数据包表单未就绪');
  }
  const type = el.aiChatPackTypeSelect.value || 'metrics_trend';
  const appKey = String(el.aiChatPackAppSelect.value || '').trim();
  if (!appKey) {
    throw new Error('请先为自定义数据包选择应用');
  }
  const spec = {
    type,
    templateId: el.aiChatPackTemplateSelect.value,
    appKey,
    platform: String(el.aiChatPackPlatformSelect.value || '').trim() || undefined,
    from: String(el.aiChatPackFromInput.value || '').trim() || undefined,
    to: String(el.aiChatPackToInput.value || '').trim() || undefined,
    sourceSection: state.activeSection
  };
  if (type === 'metrics_trend') {
    return {
      ...spec,
      source: String(el.aiChatPackSourceSelect?.value || 'pull'),
      metric: String(el.aiChatPackMetricSelect?.value || 'installs'),
      eventName: String(el.aiChatPackEventNameInput?.value || '').trim() || undefined
    };
  }
  if (type === 'asa_keyword_summary') {
    return {
      ...spec,
      stage: String(el.aiChatPackStageSelect?.value || '').trim() || undefined
    };
  }
  return spec;
}

function primeAIChatBuilderDefaults() {
  const defaultAppKey = String(state.apps[0]?.app_key || '').trim();
  if (el.aiChatPackAppSelect instanceof HTMLSelectElement && !el.aiChatPackAppSelect.value && defaultAppKey) {
    el.aiChatPackAppSelect.value = defaultAppKey;
  }
  if (el.aiChatPackFromInput instanceof HTMLInputElement && !el.aiChatPackFromInput.value) {
    el.aiChatPackFromInput.value = toLocalDate(new Date(Date.now() - 13 * 24 * 60 * 60 * 1000));
  }
  if (el.aiChatPackToInput instanceof HTMLInputElement && !el.aiChatPackToInput.value) {
    el.aiChatPackToInput.value = toLocalDate(new Date());
  }
  syncAIChatContextBuilderVisibility();
  syncAIChatPackBuilderPreview();
}

async function loadAIChatModels() {
  const body = await api('/api/ai/models');
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const models = Array.isArray(data.models)
    ? data.models
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          id: String(item.id || '').trim(),
          label: String(item.label || '').trim(),
          provider: String(item.provider || '').trim(),
          providerLabel: String(item.provider_label || item.provider || '').trim(),
          model: String(item.model || '').trim(),
          supportsImages: item.supports_images !== false,
          supportsThinking: item.supports_thinking === true
        }))
        .filter((item) => item.id && item.label)
    : [];
  state.aiChat.availableModels = models;
  state.aiChat.defaultModelId = String(data.default_model_id || '').trim();

  const storedModelId = readStoredAIChatModelId();
  const storedModelAvailable = models.some((item) => item.id === storedModelId);
  if (storedModelId && !storedModelAvailable) {
    clearStoredAIChatModelId();
  }
  const defaultModelAvailable = models.some((item) => item.id === state.aiChat.defaultModelId);
  const nextModelId = storedModelAvailable
    ? storedModelId
    : defaultModelAvailable
      ? state.aiChat.defaultModelId
      : models[0]?.id || '';

  setAIChatModelSelection(nextModelId, { persist: storedModelAvailable });
}

function clearAIChatConversation() {
  state.aiChat.messages = [];
  clearAIChatAttachments();
  renderAIChatMessages();
}

function handleAIChatPackCardClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const button = target.closest('[data-ai-chat-pack-spec]');
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const raw = String(button.dataset.aiChatPackSpec || '').trim();
  if (!raw) {
    return;
  }
  try {
    const spec = JSON.parse(decodeURIComponent(raw));
    addAIChatContextPack(spec);
  } catch (error) {
    showToast(error.message || '数据包配置无效', true);
  }
}

function handleAIChatImageSelection(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  const files = Array.from(target.files || []);
  if (files.length === 0) {
    return;
  }
  const existing = state.aiChat.selectedImages || [];
  if (existing.length + files.length > 4) {
    target.value = '';
    throw new Error('图片最多上传 4 张');
  }

  const next = [...existing];
  files.forEach((file) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      throw new Error(`不支持的图片格式：${file.name}`);
    }
    if (file.size > 5 * 1024 * 1024) {
      throw new Error(`图片过大：${file.name}`);
    }
    next.push({
      id: aiChatMessageId(),
      file,
      previewUrl: URL.createObjectURL(file)
    });
  });
  state.aiChat.selectedImages = next;
  target.value = '';
  renderAIChatAttachmentStrip();
  setAIChatContextMenuOpen(false);
  const currentModel = getAIChatModelOption(state.aiChat.currentModelId);
  if (currentModel && currentModel.supportsImages === false) {
    showToast(`当前 ${currentModel.label} 仅支持文本，发送时会自动切回支持图片的模型。`);
    return;
  }
  showToast(`已附加 ${files.length} 张图片`);
}

function handleAIChatAttachmentStripClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const removeImageId = String(target.dataset.aiChatImageRemove || '').trim();
  if (removeImageId) {
    removeAIChatImage(removeImageId);
    return;
  }
  const removePackKey = String(target.dataset.aiChatPackRemove || '').trim();
  if (removePackKey) {
    removeAIChatContextPack(removePackKey);
  }
}

async function sendAIChat(event) {
  event?.preventDefault?.();
  if (state.aiChat.pending) {
    return;
  }
  if (!state.aiChat.currentModelId) {
    throw new Error('Guru Ads Agent 当前没有可用模型，请联系管理员检查模型配置。');
  }
  const draft = String(el.aiChatInput?.value || '').trim();
  const images = [...(state.aiChat.selectedImages || [])];
  const packs = [...(state.aiChat.selectedContextPacks || [])];
  if (!draft && images.length === 0 && packs.length === 0) {
    throw new Error('请先输入内容，或者附带图片 / 数据包');
  }
  let requestModel = getAIChatModelOption(state.aiChat.currentModelId);
  if (images.length > 0 && requestModel && requestModel.supportsImages === false) {
    const fallbackModel = getAIChatFallbackModel({
      requiresImages: true,
      excludeModelId: requestModel.id
    });
    if (!fallbackModel) {
      throw createAIChatRequestError(
        'ai_model_images_unsupported',
        '当前已附带图片，但没有可自动切换的图片模型，请移除图片后再试。',
        400
      );
    }
    setAIChatModelSelection(fallbackModel.id, { persist: true });
    requestModel = fallbackModel;
    showToast(`当前已附带图片，已自动切回 ${fallbackModel.label}。`);
  }
  const requestModelId = requestModel?.id || state.aiChat.currentModelId;
  const currentModelLabel = requestModel?.label || getAIChatCurrentModelLabel();

  const history = (state.aiChat.messages || [])
    .filter((item) => !item.pending && (item.role === 'user' || item.role === 'assistant'))
    .slice(-80)
    .map((item) => ({
      role: item.role,
      content: item.content,
      meta: item.meta
        ? {
            agent_action: item.meta.agentAction || undefined,
            clarification_round: item.meta.clarificationRound || undefined,
            page_trace: Array.isArray(item.pageTrace)
              ? item.pageTrace.map((trace) => ({
                  title: trace.title,
                  brief: trace.brief
                }))
              : undefined,
            tool_trace: Array.isArray(item.toolTrace)
              ? item.toolTrace.map((trace) => ({
                  tool: trace.tool,
                  title: trace.title,
                  brief: trace.brief
                }))
              : undefined
          }
        : undefined
    }));
  const pageContext = buildAIChatPageContext();

  const attachmentSnapshot = [
    ...images.map((item) => ({ type: 'image', title: item.file.name })),
    ...packs.map((item) => ({ type: 'context', title: item.title }))
  ];

  const userMessage = {
    id: aiChatMessageId(),
    role: 'user',
    content: draft || '请结合我附带的附件进行分析。',
    attachments: attachmentSnapshot,
    createdAt: new Date().toISOString()
  };
  const pendingMessage = {
    id: aiChatMessageId(),
    role: 'assistant',
    content: '处理中',
    attachments: [],
    createdAt: new Date().toISOString(),
    modelLabel: currentModelLabel || undefined,
    pending: true
  };

  state.aiChat.messages = [...(state.aiChat.messages || []), userMessage, pendingMessage];
  state.aiChat.pending = true;
  syncAIChatModelUi();
  if (el.aiChatInput instanceof HTMLTextAreaElement) {
    el.aiChatInput.value = '';
  }
  syncAIChatInputHeight();
  clearAIChatAttachments();
  renderAIChatMessages();

  try {
    const formData = new FormData();
    formData.set('message', draft);
    formData.set('model_id', requestModelId);
    formData.set('history_json', JSON.stringify(history));
    formData.set(
      'context_packs_json',
      JSON.stringify(
        packs.map((item) => ({
          ...item.spec
        }))
      )
    );
    formData.set('page_context_json', JSON.stringify(pageContext));
    for (const image of images) {
      formData.append('images', image.file, image.file.name);
    }

    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      body: formData
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      throw createAIChatRequestError(
        body.error || '',
        body.message ||
          getAIChatErrorMessage(body.error) ||
          getRecommendationPolicyErrorMessage(body.error) ||
          body.error ||
          `request_failed_${res.status}`,
        res.status
      );
    }

    const result = body.data || {};
    state.aiChat.messages = (state.aiChat.messages || []).filter((item) => item.id !== pendingMessage.id);
    const pageTrace = Array.isArray(result.page_trace)
      ? result.page_trace
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            title: String(item.title || '').trim(),
            brief: String(item.brief || '').trim()
          }))
          .filter((item) => item.title)
      : [];
    const toolTrace = Array.isArray(result.tool_trace)
      ? result.tool_trace
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            tool: String(item.tool || '').trim(),
            title: String(item.title || '').trim(),
            brief: String(item.brief || '').trim()
          }))
          .filter((item) => item.title)
      : [];
    const agentAction = String(result.agent_action || '').trim() === 'clarification' ? 'clarification' : 'answer';
    const clarificationCount = Number(result.clarification_count || 0) || 0;
    state.aiChat.messages.push({
      id: aiChatMessageId(),
      role: 'assistant',
      content: String(result.reply || '').trim() || '模型没有返回可展示内容。',
      modelLabel: String(result.model_label || currentModelLabel || '').trim() || undefined,
      pageTrace,
      toolTrace,
      meta: {
        agentAction,
        clarificationRound: clarificationCount
      },
      attachments: (result.attachments_used?.context_packs || []).map((item) => ({
        type: 'context',
        title: item.title || '上下文包'
      })),
      createdAt: new Date().toISOString()
    });
    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      state.aiChat.messages.push({
        id: aiChatMessageId(),
        role: 'system',
        content: `部分上下文已降级处理：${result.warnings.join('；')}`,
        attachments: [],
        createdAt: new Date().toISOString()
      });
    }
    renderAIChatMessages();
  } catch (error) {
    const errorCode = String(error.code || '').trim();
    const fallbackModel = maybeFallbackAIChatModelAfterFailure(errorCode, {
      failedModelId: requestModelId,
      requiresImages: images.length > 0
    });
    state.aiChat.messages = (state.aiChat.messages || []).filter((item) => item.id !== pendingMessage.id);
    state.aiChat.messages.push({
      id: aiChatMessageId(),
      role: 'system',
      content: error.message || 'Guru Ads Agent 请求失败，请稍后重试。',
      attachments: [],
      createdAt: new Date().toISOString()
    });
    if (fallbackModel) {
      state.aiChat.messages.push({
        id: aiChatMessageId(),
        role: 'system',
        content: `已自动切回 ${fallbackModel.label}，下次发送会优先使用这个模型。`,
        attachments: [],
        createdAt: new Date().toISOString()
      });
    }
    renderAIChatMessages();
    showToast(error.message || 'Guru Ads Agent 请求失败', true);
  } finally {
    state.aiChat.pending = false;
    syncAIChatModelUi();
  }
}

function handleAIChatInputKeydown(event) {
  if (!(event instanceof KeyboardEvent)) {
    return;
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) {
    return;
  }
  event.preventDefault();
  sendAIChat().catch((error) => {
    showToast(error.message || '发送失败', true);
  });
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
    throw new Error(
      body.message || getRecommendationPolicyErrorMessage(body.error) || body.error || `request_failed_${res.status}`
    );
  }
  return body;
}

function fmtTime(v) {
  if (!v) return '-';
  return new Date(v).toLocaleString();
}

function toSqlDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function toSqlDate(date) {
  return toLocalDate(date);
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
  if (status === 'open') return '未恢复';
  if (status === 'resolved') return '已恢复';
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
  if (metric === 'revenue') return '收入金额';
  if (metric === 'event_count') return '事件次数';
  if (metric === 'purchase_count') return '购买次数';
  if (metric === 'installs') return '安装量';
  if (metric === 'clicks') return '点击量';
  if (metric === 'total_cost') return '花费金额';
  return metric || '-';
}

function platformLabel(platform) {
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  if (platform === 'unknown') return '未知';
  return platform || '-';
}

function timezoneLabel(timezone) {
  if (!timezone || timezone === 'Asia/Shanghai') return '北京时间（UTC+8）';
  return timezone;
}

function primaryMetricLabel(metric) {
  if (metric === 'roas') return '回收率（ROAS）';
  return '每次安装成本（eCPI）';
}

function metricModeLabel(mode, roasDataStatus) {
  if (roasDataStatus === 'pending' || mode === 'roas_pending_revenue') return '收入数据待补齐';
  if (roasDataStatus === 'partial') return '覆盖率达阈值（按已覆盖成本计算）';
  if (roasDataStatus === 'partial_low') return '覆盖率偏低（仅供参考）';
  if (roasDataStatus === 'unavailable') return '暂无成熟数据';
  return '当前生效';
}

function asaStageLabel(stage) {
  if (stage === 'stable') return '稳定期';
  if (stage === 'rising') return '上升期';
  return stage || '-';
}

function asaRecommendationStatusLabel(status) {
  const mapping = {
    pending: '本次新增建议',
    sent: '历史已发建议',
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
  if (matchType === 'unknown') return '未知';
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
    pending: '待处理',
    applied: '已执行',
    rejected: '不执行',
    expired: '已过期'
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

function normalizeExecutionActions(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item && typeof item === 'object');
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeScenarioTags(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || '').trim()).filter(Boolean);
      }
    } catch {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function scenarioTagLabel(tag) {
  const mapping = {
    low_spend_signal_weak: '低量级信号偏弱',
    high_spend_uptrend_expandable: '高量级上涨可扩量'
  };
  return mapping[tag] || tag || '';
}

function formatBudgetExecutionActionSummary(row, llmSummary = null) {
  const executionActions = normalizeExecutionActions(row?.execution_actions);
  if (executionActions.length > 0) {
    return executionActions
      .map((item) => String(item.label || '').trim())
      .filter(Boolean)
      .join(' / ');
  }
  const summary = llmSummary || safeJsonParse(row?.llm_summary, {});
  const actionItems = Array.isArray(summary?.action_items)
    ? summary.action_items.map((item) => String(item).trim()).filter(Boolean)
    : [];
  return actionItems.slice(0, 2).join(' / ');
}

function formatBudgetScenarioTagSummary(row, llmSummary = null) {
  const tags = normalizeScenarioTags(row?.scenario_tags);
  if (tags.length > 0) {
    return tags.map((item) => scenarioTagLabel(item)).join(' / ');
  }
  const summary = llmSummary || safeJsonParse(row?.llm_summary, {});
  return normalizeScenarioTags(summary?.scenario_tags)
    .map((item) => scenarioTagLabel(item))
    .join(' / ');
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

function severityLabel(severity) {
  if (severity === 'P0') return 'P0（立即处理）';
  if (severity === 'P1') return 'P1（今日处理）';
  if (severity === 'P2') return 'P2（持续关注）';
  return severity || '-';
}

function operationSourceLabel(source) {
  const mapping = {
    'api.apps': '应用设置',
    'api.rules': '规则设置',
    'api.pull_records': '广告日报明细',
    'api.keywords': '关键词生命周期',
    'api.budget': '预算建议',
    'api.daily_brief': '每日简报',
    'api.bitable_export': '投放执行表',
    'worker.aggregator': '小时聚合任务',
    'worker.detector': '告警检测任务',
    'worker.puller': '广告日报抓取任务',
    'worker.keyword_engine': '关键词分析任务',
    'worker.budget_advisor': '预算建议任务',
    'worker.daily_brief': '每日报告任务',
    'worker.bitable_export': '执行表同步任务',
    'worker.bitable_feedback_sync': '执行反馈回读任务',
    'system.bitable_export_seed': '执行表导出补种'
  };
  return mapping[source] || source || '-';
}

function operationActionLabel(action) {
  const mapping = {
    create: '新建',
    update: '更新',
    delete: '删除',
    enable: '启用',
    disable: '停用',
    preview: '预览',
    send: '发送',
    run: '执行',
    recompute: '重算',
    save: '保存',
    refresh: '刷新',
    trigger: '手动触发'
  };
  return mapping[action] || action || '-';
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
    ? '当前启用应用级飞书配置。未填写的项不会覆盖现有值。'
    : '当前使用系统默认的全局飞书配置。如需单独通知到某个机器人或群聊，再手动启用。';

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

function syncHelpTriggerExpandedState(group, expanded) {
  const trigger = getHelpTrigger(group);
  if (trigger instanceof HTMLElement) {
    trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
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
  syncHelpTriggerExpandedState(group, true);
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
  syncHelpTriggerExpandedState(group, false);
}

function hideAllHelpPopovers() {
  helpPopoverGroups.forEach((group) => hideHelpPopover(group));
}

function toggleHelpPopover(group) {
  const popover = getHelpPopover(group);
  if (!popover) {
    return;
  }
  if (popover.classList.contains('is-visible')) {
    hideHelpPopover(group);
    return;
  }
  hideAllHelpPopovers();
  showHelpPopover(group);
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

function renderPlainTextHtml(raw) {
  return escapeHtml(raw).replace(/\n/g, '<br />');
}

function renderMarkdownInline(raw) {
  const tokens = [];
  let html = escapeHtml(raw ?? '');

  html = html.replace(/`([^`\n]+)`/g, (_match, content) => {
    const token = `__AI_MD_TOKEN_${tokens.length}__`;
    tokens.push(`<code>${content}</code>`);
    return token;
  });

  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    const token = `__AI_MD_TOKEN_${tokens.length}__`;
    tokens.push(
      `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`
    );
    return token;
  });

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  tokens.forEach((tokenHtml, index) => {
    html = html.replaceAll(`__AI_MD_TOKEN_${index}__`, tokenHtml);
  });

  return html;
}

function renderMarkdownBlock(block) {
  const lines = String(block || '')
    .split('\n')
    .map((line) => line.trimEnd());
  if (lines.length === 0) {
    return '';
  }

  if (lines.every((line) => /^\s*```/.test(line))) {
    return '';
  }

  const codeFenceMatch = block.match(/^```([\w-]+)?\n([\s\S]*?)\n```$/);
  if (codeFenceMatch) {
    return `<pre><code>${escapeHtml(codeFenceMatch[2])}</code></pre>`;
  }

  if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
    const items = lines
      .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
      .filter(Boolean)
      .map((line) => `<li>${renderMarkdownInline(line)}</li>`)
      .join('');
    return items ? `<ul>${items}</ul>` : '';
  }

  if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
    const items = lines
      .map((line) => line.replace(/^\s*\d+\.\s+/, '').trim())
      .filter(Boolean)
      .map((line) => `<li>${renderMarkdownInline(line)}</li>`)
      .join('');
    return items ? `<ol>${items}</ol>` : '';
  }

  const headingMatch = block.match(/^\s{0,3}(#{1,3})\s+(.+)$/);
  if (headingMatch) {
    const level = Math.min(3, headingMatch[1].length);
    return `<h${level}>${renderMarkdownInline(headingMatch[2].trim())}</h${level}>`;
  }

  if (lines.every((line) => /^\s*>\s?/.test(line))) {
    const quoteText = lines.map((line) => line.replace(/^\s*>\s?/, '')).join('<br />');
    return `<blockquote>${renderMarkdownInline(quoteText)}</blockquote>`;
  }

  return `<p>${lines.map((line) => renderMarkdownInline(line)).join('<br />')}</p>`;
}

function renderMarkdownHtml(raw) {
  const normalized = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }
  return normalized
    .split(/\n{2,}/)
    .map((block) => renderMarkdownBlock(block))
    .filter(Boolean)
    .join('');
}

function renderAIChatMessageBubble(item) {
  if (item.pending) {
    return {
      bubbleClass: 'is-pending',
      bubbleHtml:
        '<span class="ai-chat-pending-copy">处理中</span><span class="ai-chat-dot-loader" aria-hidden="true">...</span>'
    };
  }
  if (item.role === 'user') {
    return {
      bubbleClass: 'is-plain',
      bubbleHtml: renderPlainTextHtml(item.content || '')
    };
  }
  return {
    bubbleClass: 'is-markdown',
    bubbleHtml: renderMarkdownHtml(item.content || '')
  };
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
    el.metricsEventNameInput.value = '广告日报（日级）下不可用';
    el.metricsEventNameInput.placeholder = '';
    el.metricsEventNameInput.disabled = true;
    el.metricsEventNameInput.setAttribute('aria-disabled-note', 'true');
    el.metricsDesc.textContent = '查看最近 14 天广告日报（日级）趋势。';
    if (submitBtn) {
      submitBtn.textContent = '加载最近 14 天';
    }
  } else {
    el.metricsEventNameInput.value = '';
    el.metricsEventNameInput.placeholder = '例如 purchase';
    el.metricsEventNameInput.disabled = false;
    el.metricsEventNameInput.removeAttribute('aria-disabled-note');
    el.metricsDesc.textContent = '查看最近 72 小时实时回传（小时级）趋势。';
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
  if (state.aiChat.contextMenuOpen || el.aiDock?.classList.contains('is-open')) {
    renderAIChatPackMenus();
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

function setRulesSectionExpanded(expanded) {
  state.rulesSectionExpanded = expanded === true;
  el.rulesSectionBody?.classList.toggle('hidden', !state.rulesSectionExpanded);
  if (el.toggleRulesSectionBtn) {
    el.toggleRulesSectionBtn.textContent = state.rulesSectionExpanded ? '收起规则设置' : '展开规则设置';
  }
  if (el.rulesSectionSummary) {
    el.rulesSectionSummary.textContent = state.rulesSectionExpanded
      ? '当前已展开。这里是高级设置区，适合修改规则、启停规则和检查配置。'
      : '当前默认收起。需要编辑规则、启停规则或查看高级配置时再展开。';
  }
}

function updateOverviewCards(refreshedAt = new Date()) {
  const pendingBudgetCount = (state.budgetRows || []).filter((row) => row.status === 'pending').length;
  const pendingAsaCount = (state.asaKeywordRows || []).filter((row) => row.recommendation_status === 'pending').length;
  el.ovApps.textContent = String(state.openAlertTotalCount);
  el.ovRules.textContent = String(pendingBudgetCount);
  el.ovOpenAlerts.textContent = String(pendingAsaCount);
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
  if (el.recommendationPolicyAppSelect) {
    el.recommendationPolicyAppSelect.innerHTML = '<option value="">请选择要配置的应用</option>';
  }
  if (el.aiChatPackAppSelect instanceof HTMLSelectElement) {
    const appOptions = state.apps
      .map((a) => `<option value="${a.app_key}">${escapeHtml(displayNameOfApp(a))} (${a.app_key})</option>`)
      .join('');
    el.aiChatPackAppSelect.innerHTML = `<option value="">请选择应用</option>${appOptions}`;
  }

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
  renderRecommendationPolicySelectionFields();
  primeAIChatBuilderDefaults();
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
        <td>${escapeHtml(timezoneLabel(app.timezone))}</td>
        <td>${hasAppLevelFeishuConfig(app) ? '应用级飞书配置' : '全局默认配置'}</td>
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
  el.appSubmitBtn.textContent = '保存应用设置';
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
  el.appSubmitBtn.textContent = `更新应用设置：${app.app_key}`;
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

function recommendationPolicyKey(row) {
  return [row.app_key, row.platform, row.engine].join('|');
}

const RECOMMENDATION_POLICY_STEP_COUNT = 4;
const RECOMMENDATION_POLICY_TARGET_FIELDS = {
  ecpi: ['ecpi_max'],
  d7_roas_cpp: ['roas_min', 'roas_good', 'cpp_max', 'cpp_pause_threshold'],
  relative_compare: []
};
const RECOMMENDATION_POLICY_TARGET_FIELD_META = {
  ecpi_max: { label: 'eCPI 目标', step: '0.01', placeholder: '例如 3' },
  roas_min: { label: 'ROAS 合格线', step: '0.01', placeholder: '例如 0.3' },
  roas_good: { label: 'ROAS 优秀线', step: '0.01', placeholder: '例如 0.5' },
  cpp_max: { label: 'CPP 上限', step: '0.01', placeholder: '例如 40' },
  cpp_pause_threshold: { label: 'CPP 暂停线', step: '0.01', placeholder: '例如 60' }
};

function cloneRecommendationPolicyDraft(draft) {
  return JSON.parse(JSON.stringify(draft));
}

function getRecommendationPolicyEditor() {
  if (!state.recommendationPolicyEditor) {
    state.recommendationPolicyEditor = createInitialRecommendationPolicyEditor();
  }
  return state.recommendationPolicyEditor;
}

function createRecommendationPolicySelection(overrides = {}) {
  const editor = getRecommendationPolicyEditor();
  const rawEngine = String(overrides.engine ?? editor.selection?.engine ?? '').trim().toLowerCase();
  return {
    platform: String(overrides.platform ?? editor.selection?.platform ?? '').trim().toLowerCase(),
    appKey: String(overrides.appKey ?? editor.selection?.appKey ?? '').trim(),
    engine: rawEngine === 'budget' || rawEngine === 'asa' ? rawEngine : ''
  };
}

function isRecommendationPolicySelectionComplete(selection) {
  return Boolean(selection?.platform && selection?.appKey && selection?.engine);
}

function isSameRecommendationPolicySelection(left, right) {
  return (
    String(left?.platform || '') === String(right?.platform || '') &&
    String(left?.appKey || '') === String(right?.appKey || '') &&
    String(left?.engine || '') === String(right?.engine || '')
  );
}

function isRecommendationPolicyEnginePlatformAllowed(engine, platform) {
  if (!engine || !platform) {
    return true;
  }
  if (engine === 'asa') {
    return platform === 'ios';
  }
  return ['ios', 'android', 'unknown'].includes(platform);
}

function buildRecommendationPolicyPlatformOptions(engine) {
  const items = ['<option value="">请选择平台</option>', '<option value="ios">iOS</option>'];
  if (engine !== 'asa') {
    items.push('<option value="android">Android</option>', '<option value="unknown">未知</option>');
  }
  return items.join('');
}

function normalizeRecommendationPolicySelectionForEngine(selection) {
  const nextSelection = createRecommendationPolicySelection(selection);
  let platformAdjusted = false;
  let appCleared = false;
  if (!isRecommendationPolicyEnginePlatformAllowed(nextSelection.engine, nextSelection.platform)) {
    nextSelection.platform = nextSelection.engine === 'asa' ? 'ios' : '';
    platformAdjusted = true;
  }
  const nextApp = (state.apps || []).find((app) => app.app_key === nextSelection.appKey);
  if (nextSelection.appKey && !appSupportsRecommendationPlatform(nextApp, nextSelection.platform)) {
    nextSelection.appKey = '';
    appCleared = true;
  }
  return {
    selection: nextSelection,
    platformAdjusted,
    appCleared
  };
}

function policyTargetFieldsForMetricFamily(metricFamily) {
  return RECOMMENDATION_POLICY_TARGET_FIELDS[metricFamily] || RECOMMENDATION_POLICY_TARGET_FIELDS.ecpi;
}

function appSupportsRecommendationPlatform(app, platform) {
  if (!app) {
    return false;
  }
  if (platform === 'ios') {
    return Boolean(app.ios_pull_app_id);
  }
  if (platform === 'android') {
    return Boolean(app.android_pull_app_id);
  }
  if (platform === 'unknown') {
    return Boolean(app.pull_app_id);
  }
  return false;
}

function buildRecommendationPolicyAppOptions(platform) {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const items = ['<option value="">请选择要配置的应用</option>'];
  if (!normalizedPlatform) {
    return items.join('');
  }
  for (const app of (state.apps || []).filter((item) => appSupportsRecommendationPlatform(item, normalizedPlatform))) {
    const name = productViewName(app.app_key, normalizedPlatform);
    items.push(
      `<option value="${escapeHtml(app.app_key)}">${escapeHtml(name)}${name === app.app_key ? '' : ` (${escapeHtml(app.app_key)})`}</option>`
    );
  }
  return items.join('');
}

function getRecommendationPolicyRowBySelection(selection) {
  return (state.recommendationPolicies || []).find(
    (item) =>
      item.app_key === selection.appKey && item.platform === selection.platform && item.engine === selection.engine
  );
}

function renderRecommendationPolicySelectionFields() {
  if (!el.recommendationPolicyPlatformSelect || !el.recommendationPolicyAppSelect || !el.recommendationPolicyEngineSelect) {
    return;
  }
  const editor = getRecommendationPolicyEditor();
  const selection = editor.selection || createRecommendationPolicySelection();
  el.recommendationPolicyPlatformSelect.innerHTML = buildRecommendationPolicyPlatformOptions(selection.engine);
  el.recommendationPolicyPlatformSelect.value = selection.platform || '';
  el.recommendationPolicyEngineSelect.value = selection.engine || '';
  el.recommendationPolicyAppSelect.innerHTML = buildRecommendationPolicyAppOptions(selection.platform);
  const appExists = (state.apps || []).some(
    (app) => app.app_key === selection.appKey && appSupportsRecommendationPlatform(app, selection.platform)
  );
  el.recommendationPolicyAppSelect.value = selection.platform && appExists ? selection.appKey || '' : '';
}

function renderRecommendationPolicySelectionPreview() {
  if (!el.recommendationPolicySelectionPreview || !el.recommendationPolicySourceSummary) {
    return;
  }
  const editor = getRecommendationPolicyEditor();
  const selection = editor.selection || {};
  if (!isRecommendationPolicySelectionComplete(selection)) {
    el.recommendationPolicySelectionPreview.textContent = '还没有完整选择，请先选择平台、应用和建议类型。';
    el.recommendationPolicySourceSummary.textContent = '选择完成后会自动载入已保存规则或推荐模板。';
    return;
  }
  const appName = productViewName(selection.appKey, selection.platform);
  const engineLabel = POLICY_ENGINE_LABELS[selection.engine] || selection.engine;
  el.recommendationPolicySelectionPreview.textContent = `${platformLabel(selection.platform)} / ${appName} / ${engineLabel}`;

  if (editor.source === 'saved') {
    el.recommendationPolicySourceSummary.textContent = '当前已载入这组配置的已保存规则。修改后保存，会直接更新这一个组合。';
    return;
  }
  if (editor.source === 'recommended') {
    el.recommendationPolicySourceSummary.textContent = '当前无已保存规则，系统已先载入推荐模板，你可以在此基础上继续调整。';
    return;
  }
  if (editor.source === 'blank') {
    el.recommendationPolicySourceSummary.textContent = '当前使用的是空白模板，只保留系统必填默认值，适合从零开始配置。';
    return;
  }
  el.recommendationPolicySourceSummary.textContent = '选择完成后会自动载入已保存规则或推荐模板。';
}

function renderRecommendationPolicyStatusCopy() {
  if (!el.recommendationPolicyStateBadge || !el.recommendationPolicyStatusTitle || !el.recommendationPolicyStatus) {
    return;
  }
  const editor = getRecommendationPolicyEditor();
  const selection = editor.selection || {};
  let badgeText = '未开始配置';
  let title = '先选择平台、应用和建议类型';
  let message = '保存时只会影响当前选择的应用、平台和建议类型，不会改动其他组合。';
  const isMuted = editor.source === 'unselected';

  if (isRecommendationPolicySelectionComplete(selection)) {
    const appName = productViewName(selection.appKey, selection.platform);
    const engineLabel = POLICY_ENGINE_LABELS[selection.engine] || selection.engine;
    title = `正在配置 ${appName} 的${engineLabel}`;
    if (editor.source === 'saved') {
      badgeText = '已载入已保存规则';
      message = '当前展示的是这组已保存规则。修改后保存，会覆盖当前组合的规则配置。';
    } else if (editor.source === 'recommended') {
      badgeText = '已载入推荐模板';
      message = '当前组合还没有已保存规则，系统已按推荐模板为你填好常用默认值。';
    } else if (editor.source === 'blank') {
      badgeText = '当前为空白模板';
      message = '当前组合使用空白模板，只保留系统默认值，适合从零开始配置。';
    }
  }

  if (editor.dirty) {
    message = `${message} 你还有未保存的修改。`;
  }

  el.recommendationPolicyStateBadge.textContent = badgeText;
  el.recommendationPolicyStateBadge.classList.toggle('is-muted', isMuted);
  el.recommendationPolicyStatusTitle.textContent = title;
  el.recommendationPolicyStatus.textContent = message;
}

function renderRecommendationPolicyStepState() {
  const editor = getRecommendationPolicyEditor();
  const currentStep = Math.min(RECOMMENDATION_POLICY_STEP_COUNT, Math.max(1, Number(editor.step) || 1));
  editor.step = currentStep;

  el.recommendationPolicySteps
    ?.querySelectorAll('[data-policy-step-target]')
    .forEach((node) => {
      const target = Number(node.getAttribute('data-policy-step-target') || '1');
      node.classList.toggle('is-active', target === currentStep);
      node.classList.toggle('is-complete', target < currentStep);
    });

  el.recommendationPolicyForm
    ?.querySelectorAll('[data-policy-step-panel]')
    .forEach((node) => {
      const target = Number(node.getAttribute('data-policy-step-panel') || '1');
      node.classList.toggle('hidden', target !== currentStep);
    });

  if (el.recommendationPolicyPrevBtn) {
    el.recommendationPolicyPrevBtn.disabled = currentStep <= 1;
  }
  if (el.recommendationPolicyNextBtn) {
    el.recommendationPolicyNextBtn.disabled = currentStep >= RECOMMENDATION_POLICY_STEP_COUNT;
    el.recommendationPolicyNextBtn.textContent =
      currentStep >= RECOMMENDATION_POLICY_STEP_COUNT ? '已到最后一步' : '下一步';
  }
  if (el.recommendationPolicySaveBtn) {
    el.recommendationPolicySaveBtn.classList.toggle('hidden', currentStep !== RECOMMENDATION_POLICY_STEP_COUNT);
  }
}

function renderRecommendationPolicyMediaSourceChips() {
  if (!el.recommendationPolicyMediaSourcesChips || !el.recommendationPolicyMediaSourceDraftInput || !el.recommendationPolicyAddMediaSourceBtn) {
    return;
  }
  const editor = getRecommendationPolicyEditor();
  const mediaSources = Array.isArray(editor.draft?.mediaSources) ? editor.draft.mediaSources : [];
  const isActive = editor.draft?.trafficScope === 'media_sources';
  el.recommendationPolicyMediaSourceDraftInput.disabled = !isActive;
  el.recommendationPolicyAddMediaSourceBtn.disabled = !isActive;

  if (mediaSources.length === 0) {
    el.recommendationPolicyMediaSourcesChips.innerHTML =
      '<span class="policy-chip-empty">还没有限制媒体源。只有在选择“指定媒体源”时，这里的内容才会生效。</span>';
    return;
  }

  el.recommendationPolicyMediaSourcesChips.innerHTML = mediaSources
    .map(
      (item) => `
        <span class="policy-chip">
          <span>${escapeHtml(item)}</span>
          <button
            class="policy-chip-remove"
            type="button"
            aria-label="移除媒体源 ${escapeHtml(item)}"
            data-policy-chip-kind="mediaSources"
            data-policy-chip-value="${escapeHtml(item)}"
          >
            ×
          </button>
        </span>
      `
    )
    .join('');
}

function renderRecommendationPolicyContextWindowChips() {
  if (!el.recommendationPolicyContextWindowChips) {
    return;
  }
  const editor = getRecommendationPolicyEditor();
  const windows = Array.isArray(editor.draft?.contextWindowDays) ? editor.draft.contextWindowDays : [];
  if (windows.length === 0) {
    el.recommendationPolicyContextWindowChips.innerHTML =
      '<span class="policy-chip-empty">当前没有上下文窗口。推荐保留 7、14、21 天三个窗口。</span>';
    return;
  }
  el.recommendationPolicyContextWindowChips.innerHTML = windows
    .map(
      (item) => `
        <span class="policy-chip">
          <span>${escapeHtml(String(item))} 天</span>
          <button
            class="policy-chip-remove"
            type="button"
            aria-label="移除 ${escapeHtml(String(item))} 天窗口"
            data-policy-chip-kind="contextWindowDays"
            data-policy-chip-value="${escapeHtml(String(item))}"
          >
            ×
          </button>
        </span>
      `
    )
    .join('');
}

function renderRecommendationPolicyTargetRows(kind) {
  const listEl =
    kind === 'country' ? el.recommendationPolicyCountryTargetsList : el.recommendationPolicyMediaTargetsList;
  if (!listEl) {
    return;
  }
  const editor = getRecommendationPolicyEditor();
  const metricFamily = editor.draft?.metricFamily || 'ecpi';
  const fields = policyTargetFieldsForMetricFamily(metricFamily);
  const rows = Array.isArray(editor.draft?.[kind === 'country' ? 'countryTargets' : 'mediaTargets'])
    ? editor.draft[kind === 'country' ? 'countryTargets' : 'mediaTargets']
    : [];

  if (fields.length === 0) {
    listEl.innerHTML = '';
    return;
  }

  if (rows.length === 0) {
    listEl.innerHTML =
      `<div class="policy-target-empty">${kind === 'country' ? '还没有国家单独阈值。' : '还没有媒体源单独阈值。'}</div>`;
    return;
  }

  listEl.innerHTML = rows
    .map((row, index) => {
      const keyLabel = kind === 'country' ? '国家 / 地区' : '媒体源';
      const rowTitle = kind === 'country' ? `国家阈值 ${index + 1}` : `媒体源阈值 ${index + 1}`;
      const fieldInputs = fields
        .map((field) => {
          const meta = RECOMMENDATION_POLICY_TARGET_FIELD_META[field];
          return `
            <label class="filter-field">
              <span class="field-label">${escapeHtml(meta.label)}</span>
              <input
                type="number"
                min="0"
                step="${escapeHtml(meta.step)}"
                placeholder="${escapeHtml(meta.placeholder)}"
                value="${escapeHtml(String(row[field] || ''))}"
                data-policy-target-kind="${escapeHtml(kind)}"
                data-policy-target-row-id="${escapeHtml(row.id)}"
                data-policy-target-field="${escapeHtml(field)}"
              />
            </label>
          `;
        })
        .join('');
      return `
        <div class="policy-target-row" data-policy-target-kind="${escapeHtml(kind)}" data-policy-target-row-id="${escapeHtml(row.id)}">
          <div class="policy-target-row-head">
            <strong>${escapeHtml(rowTitle)}</strong>
            <div class="table-actions">
              <button class="btn btn-ghost btn-compact" type="button" data-policy-target-copy="${escapeHtml(row.id)}" data-policy-target-kind="${escapeHtml(kind)}">复制</button>
              <button class="btn btn-ghost btn-compact" type="button" data-policy-target-remove="${escapeHtml(row.id)}" data-policy-target-kind="${escapeHtml(kind)}">删除</button>
            </div>
          </div>
          <div class="policy-target-row-fields">
            <label class="filter-field">
              <span class="field-label">${keyLabel}</span>
              <input
                type="text"
                placeholder="${kind === 'country' ? '例如 US 或 BR' : '例如 Apple Search Ads'}"
                value="${escapeHtml(String(row.key || ''))}"
                data-policy-target-kind="${escapeHtml(kind)}"
                data-policy-target-row-id="${escapeHtml(row.id)}"
                data-policy-target-key="true"
              />
            </label>
            ${fieldInputs}
          </div>
        </div>
      `;
    })
    .join('');

  applyUniformFieldLabels();
}

function renderRecommendationPolicyFieldVisibility() {
  const editor = getRecommendationPolicyEditor();
  const metricFamily = editor.draft?.metricFamily || 'ecpi';
  const isRelative = metricFamily === 'relative_compare';
  el.recommendationPolicyEcpiGroup?.classList.toggle('hidden', metricFamily !== 'ecpi');
  el.recommendationPolicyRoasGroup?.classList.toggle('hidden', metricFamily !== 'd7_roas_cpp');
  el.recommendationPolicyRelativeGroup?.classList.toggle('hidden', metricFamily !== 'relative_compare');
  el.recommendationPolicyTargetOverridesBlock?.classList.toggle('hidden', isRelative);
  renderRecommendationPolicyMediaSourceChips();
  renderRecommendationPolicyContextWindowChips();
  renderRecommendationPolicyTargetRows('country');
  renderRecommendationPolicyTargetRows('media');
}

function renderRecommendationPolicyReview() {
  if (!el.recommendationPolicyImpactSummary || !el.recommendationPolicyReviewSummary) {
    return;
  }
  const editor = getRecommendationPolicyEditor();
  const draft = collectRecommendationPolicyDraftFromInputs();
  const selection = draft.selection;
  const appName = selection.appKey ? productViewName(selection.appKey, selection.platform) : '-';
  const review = buildRecommendationPolicyReviewSummary({
    ruleJson: mergeRecommendationPolicyRule(editor.originalRuleJson || {}, draft),
    appName,
    platformLabel: selection.platform ? platformLabel(selection.platform) : '-',
    engineLabel: POLICY_ENGINE_LABELS[selection.engine] || selection.engine || '-',
    enabled: draft.enabled
  });

  el.recommendationPolicyImpactSummary.innerHTML = review.impactItems
    .map(
      (item) => `
        <div>
          <dt>${escapeHtml(item.label)}</dt>
          <dd>${escapeHtml(item.value)}</dd>
        </div>
      `
    )
    .join('');

  el.recommendationPolicyReviewSummary.innerHTML = [
    { label: '优化目标', value: review.objective },
    { label: '生效范围', value: review.scope },
    { label: '关键阈值摘要', value: review.thresholds },
    { label: '当前状态', value: editor.dirty ? '有未保存修改' : '当前内容与已载入版本一致' }
  ]
    .map(
      (item) => `
        <div class="policy-review-item">
          <strong>${escapeHtml(item.label)}</strong>
          <span>${escapeHtml(item.value || '-')}</span>
        </div>
      `
    )
    .join('');
}

function renderRecommendationPolicyEmptyState() {
  if (!el.recommendationPolicyEmptyState) {
    return;
  }
  const editor = getRecommendationPolicyEditor();
  if ((state.apps || []).length === 0) {
    el.recommendationPolicyEmptyState.classList.remove('hidden');
    el.recommendationPolicyEmptyState.innerHTML = `
      <strong>请先新增应用，再配置调控规则</strong>
      <p>当前还没有应用可选。先到“应用设置”里创建应用，再回来配置预算或 ASA 调控规则。</p>
    `;
    return;
  }

  if (isRecommendationPolicySelectionComplete(editor.selection)) {
    const appName = productViewName(editor.selection.appKey, editor.selection.platform);
    const engineLabel = POLICY_ENGINE_LABELS[editor.selection.engine] || editor.selection.engine;
    if (editor.source === 'recommended') {
      el.recommendationPolicyEmptyState.classList.remove('hidden');
      el.recommendationPolicyEmptyState.innerHTML = `
        <strong>当前组合还没有已保存规则</strong>
        <p>已为 ${escapeHtml(appName)} 的 ${escapeHtml(engineLabel)} 载入推荐模板。你可以直接补阈值和限制条件后保存。</p>
      `;
      return;
    }
    if (editor.source === 'blank') {
      el.recommendationPolicyEmptyState.classList.remove('hidden');
      el.recommendationPolicyEmptyState.innerHTML = `
        <strong>当前组合还没有已保存规则</strong>
        <p>你正在从空白模板配置 ${escapeHtml(appName)} 的 ${escapeHtml(engineLabel)}。只保留系统默认值，适合从零开始填写。</p>
      `;
      return;
    }
  }

  if ((state.recommendationPolicies || []).length === 0) {
    el.recommendationPolicyEmptyState.classList.remove('hidden');
    el.recommendationPolicyEmptyState.innerHTML = `
      <strong>第一次配置可以按这个顺序走</strong>
      <p>先选平台，再选应用，接着选择建议类型；填好优化目标和限制条件后，最后在保存前确认影响范围。</p>
    `;
    return;
  }
  el.recommendationPolicyEmptyState.classList.add('hidden');
  el.recommendationPolicyEmptyState.innerHTML = '';
}

function renderRecommendationPolicyEditor() {
  renderRecommendationPolicySelectionFields();
  renderRecommendationPolicySelectionPreview();
  renderRecommendationPolicyStatusCopy();
  renderRecommendationPolicyStepState();
  renderRecommendationPolicyFieldVisibility();
  renderRecommendationPolicyReview();
  renderRecommendationPolicyEmptyState();
}

function applyRecommendationPolicyDraftToInputs(draft) {
  if (!draft) {
    return;
  }
  el.recommendationPolicyMetricFamilySelect.value = draft.metricFamily || 'ecpi';
  el.recommendationPolicyDecisionModeSelect.value = draft.decisionMode || 'deterministic';
  el.recommendationPolicyTrafficScopeSelect.value = draft.trafficScope || 'all';
  el.recommendationPolicyExcludeRecentInput.value = String(draft.excludeRecentDays ?? '7');
  el.recommendationPolicyDecisionWindowInput.value = String(draft.decisionWindowDays ?? '14');
  el.recommendationPolicyEcpiMaxInput.value = String(draft.globalTargets?.ecpi_max || '');
  el.recommendationPolicyRoasMinInput.value = String(draft.globalTargets?.roas_min || '');
  el.recommendationPolicyRoasGoodInput.value = String(draft.globalTargets?.roas_good || '');
  el.recommendationPolicyCppMaxInput.value = String(draft.globalTargets?.cpp_max || '');
  el.recommendationPolicyCppPauseInput.value = String(draft.globalTargets?.cpp_pause_threshold || '');
  el.recommendationPolicyRelativeUnderperformInput.value = String(draft.relativeCompare?.underperform_ratio || '');
  el.recommendationPolicyRelativePeerCountInput.value = String(draft.relativeCompare?.min_peer_count || '');
  el.recommendationPolicyRelativeMinFailedInput.value = String(draft.relativeCompare?.min_failed_metrics || '');
  el.recommendationPolicyDailyCapInput.value = String(draft.spendPolicy?.daily_budget_cap_usd || '');
  el.recommendationPolicyLowSpendInput.value = String(draft.spendPolicy?.low_spend_threshold_usd || '');
  el.recommendationPolicyHighSpendInput.value = String(draft.spendPolicy?.high_spend_threshold_usd || '');
  el.recommendationPolicyTrendLookbackInput.value = String(draft.spendPolicy?.trend_lookback_days || '7');
  el.recommendationPolicyUptrendRatioInput.value = String(draft.spendPolicy?.uptrend_min_ratio || '0.15');
  el.recommendationPolicyDefaultIncreaseRatioInput.value = String(draft.adjustmentPolicy?.default_increase_ratio || '0.2');
  el.recommendationPolicyDefaultDecreaseRatioInput.value = String(draft.adjustmentPolicy?.default_decrease_ratio || '0.2');
  el.recommendationPolicyHighSpendIncreaseRatioInput.value = String(
    draft.adjustmentPolicy?.high_spend_uptrend_increase_ratio || '0.3'
  );
  el.recommendationPolicyPromptInput.value = String(draft.manualPromptMarkdown || '');
  el.recommendationPolicyEnabledSelect.value = draft.enabled === false ? 'false' : 'true';
  el.recommendationPolicyMediaSourceDraftInput.value = '';
  el.recommendationPolicyContextWindowDraftInput.value = '';
  el.recommendationPolicyForm
    ?.querySelectorAll('input[name="recommendationPolicyRelativeMetric"]')
    .forEach((node) => {
      node.checked = Array.isArray(draft.relativeCompare?.metrics) && draft.relativeCompare.metrics.includes(node.value);
    });
}

function collectRecommendationPolicyDraftFromInputs() {
  const editor = getRecommendationPolicyEditor();
  const baseDraft = cloneRecommendationPolicyDraft(editor.draft || createPolicyTemplate(editor.selection || {}, 'blank'));
  baseDraft.selection = createRecommendationPolicySelection({
    platform: el.recommendationPolicyPlatformSelect?.value,
    appKey: el.recommendationPolicyAppSelect?.value,
    engine: el.recommendationPolicyEngineSelect?.value
  });
  baseDraft.metricFamily = String(el.recommendationPolicyMetricFamilySelect?.value || 'ecpi').trim() || 'ecpi';
  baseDraft.decisionMode = String(el.recommendationPolicyDecisionModeSelect?.value || 'deterministic').trim() || 'deterministic';
  baseDraft.trafficScope = String(el.recommendationPolicyTrafficScopeSelect?.value || 'all').trim() || 'all';
  baseDraft.excludeRecentDays = String(el.recommendationPolicyExcludeRecentInput?.value || '7').trim() || '7';
  baseDraft.decisionWindowDays = String(el.recommendationPolicyDecisionWindowInput?.value || '14').trim() || '14';
  baseDraft.globalTargets = {
    ecpi_max: String(el.recommendationPolicyEcpiMaxInput?.value || '').trim(),
    roas_min: String(el.recommendationPolicyRoasMinInput?.value || '').trim(),
    roas_good: String(el.recommendationPolicyRoasGoodInput?.value || '').trim(),
    cpp_max: String(el.recommendationPolicyCppMaxInput?.value || '').trim(),
    cpp_pause_threshold: String(el.recommendationPolicyCppPauseInput?.value || '').trim()
  };
  baseDraft.relativeCompare = {
    metrics: Array.from(
      el.recommendationPolicyForm?.querySelectorAll('input[name="recommendationPolicyRelativeMetric"]:checked') || []
    )
      .map((node) => node.value)
      .filter(Boolean),
    underperform_ratio: String(el.recommendationPolicyRelativeUnderperformInput?.value || '').trim(),
    min_peer_count: String(el.recommendationPolicyRelativePeerCountInput?.value || '').trim(),
    min_failed_metrics: String(el.recommendationPolicyRelativeMinFailedInput?.value || '').trim()
  };
  baseDraft.spendPolicy = {
    daily_budget_cap_usd: String(el.recommendationPolicyDailyCapInput?.value || '').trim(),
    low_spend_threshold_usd: String(el.recommendationPolicyLowSpendInput?.value || '').trim(),
    high_spend_threshold_usd: String(el.recommendationPolicyHighSpendInput?.value || '').trim(),
    trend_lookback_days: String(el.recommendationPolicyTrendLookbackInput?.value || '7').trim() || '7',
    uptrend_min_ratio: String(el.recommendationPolicyUptrendRatioInput?.value || '0.15').trim() || '0.15'
  };
  baseDraft.adjustmentPolicy = {
    default_increase_ratio:
      String(el.recommendationPolicyDefaultIncreaseRatioInput?.value || '0.2').trim() || '0.2',
    default_decrease_ratio:
      String(el.recommendationPolicyDefaultDecreaseRatioInput?.value || '0.2').trim() || '0.2',
    high_spend_uptrend_increase_ratio:
      String(el.recommendationPolicyHighSpendIncreaseRatioInput?.value || '0.3').trim() || '0.3'
  };
  baseDraft.manualPromptMarkdown = String(el.recommendationPolicyPromptInput?.value || '');
  baseDraft.enabled = el.recommendationPolicyEnabledSelect?.value !== 'false';
  return baseDraft;
}

function syncRecommendationPolicyDirtyState() {
  const editor = getRecommendationPolicyEditor();
  editor.draft = collectRecommendationPolicyDraftFromInputs();
  editor.dirty = buildRecommendationPolicySnapshot(editor.draft) !== editor.originalSnapshot;
}

function applyRecommendationPolicyMetricFamilyChange(nextMetricFamily) {
  const editor = getRecommendationPolicyEditor();
  const currentDraft = collectRecommendationPolicyDraftFromInputs();
  currentDraft.metricFamily = nextMetricFamily;
  const sanitizedDraft = sanitizeRecommendationPolicyDraft(currentDraft, nextMetricFamily);
  const hadHiddenChanges = buildRecommendationPolicySnapshot(currentDraft) !== buildRecommendationPolicySnapshot(sanitizedDraft);
  editor.draft = sanitizedDraft;
  applyRecommendationPolicyDraftToInputs(sanitizedDraft);
  syncRecommendationPolicyDirtyState();
  renderRecommendationPolicyFieldVisibility();
  renderRecommendationPolicyStatusCopy();
  renderRecommendationPolicyReview();
  if (hadHiddenChanges) {
    showToast('已清空当前核心指标下不再适用的隐藏阈值和单独条件。');
  }
}

function setRecommendationPolicyDraftState({ source, draft, originalRuleJson, step }) {
  const editor = getRecommendationPolicyEditor();
  editor.source = source;
  editor.draft = cloneRecommendationPolicyDraft(draft);
  editor.selection = createRecommendationPolicySelection(draft.selection);
  editor.originalRuleJson = cloneRecommendationPolicyDraft(originalRuleJson || {});
  editor.originalSnapshot = buildRecommendationPolicySnapshot(editor.draft);
  editor.dirty = false;
  editor.step = step ?? 1;
  applyRecommendationPolicyDraftToInputs(editor.draft);
  renderRecommendationPolicyEditor();
}

function loadRecommendationPolicySelection(selection, options = {}) {
  const nextSelection = createRecommendationPolicySelection(selection);
  const row = getRecommendationPolicyRowBySelection(nextSelection);
  if (row) {
    const draft = buildPolicyDraftFromRow(row);
    setRecommendationPolicyDraftState({
      source: 'saved',
      draft,
      originalRuleJson: row.rule_json || {},
      step: options.step ?? 1
    });
    return;
  }
  const templateKind = options.templateKind === 'blank' ? 'blank' : 'recommended';
  const draft = createPolicyTemplate(nextSelection, templateKind);
  setRecommendationPolicyDraftState({
    source: templateKind,
    draft,
    originalRuleJson: {},
    step: options.step ?? 1
  });
}

function resetRecommendationPolicyToPartialSelection(selection) {
  const draft = createPolicyTemplate(selection, 'blank');
  const editor = getRecommendationPolicyEditor();
  editor.source = 'unselected';
  editor.selection = createRecommendationPolicySelection(selection);
  editor.draft = draft;
  editor.originalRuleJson = {};
  editor.originalSnapshot = buildRecommendationPolicySnapshot(draft);
  editor.dirty = false;
  editor.step = 1;
  applyRecommendationPolicyDraftToInputs(draft);
  renderRecommendationPolicyEditor();
}

function confirmRecommendationPolicyDiscard() {
  const editor = getRecommendationPolicyEditor();
  if (!editor.dirty) {
    return true;
  }
  return window.confirm('当前有未保存的修改。放弃当前修改并切换吗？');
}

function handleRecommendationPolicySelectionChange(overrides = {}, options = {}) {
  const editor = getRecommendationPolicyEditor();
  const currentSelection = createRecommendationPolicySelection(editor.selection);
  const requestedSelection = createRecommendationPolicySelection({
    platform: overrides.platform ?? el.recommendationPolicyPlatformSelect?.value,
    appKey: overrides.appKey ?? el.recommendationPolicyAppSelect?.value,
    engine: overrides.engine ?? el.recommendationPolicyEngineSelect?.value
  });
  const { selection: nextSelection, platformAdjusted, appCleared } =
    normalizeRecommendationPolicySelectionForEngine(requestedSelection);

  if (isSameRecommendationPolicySelection(currentSelection, nextSelection) && !options.force) {
    renderRecommendationPolicySelectionFields();
    renderRecommendationPolicySelectionPreview();
    return;
  }

  if (!confirmRecommendationPolicyDiscard()) {
    renderRecommendationPolicySelectionFields();
    return;
  }

  if (!isRecommendationPolicySelectionComplete(nextSelection)) {
    resetRecommendationPolicyToPartialSelection(nextSelection);
    if (platformAdjusted && nextSelection.engine === 'asa') {
      showToast('ASA 规则只支持 iOS，已自动切换到 iOS。');
    }
    if (appCleared) {
      showToast('当前应用不支持新的平台组合，请重新选择应用。', true);
    }
    return;
  }
  if (platformAdjusted && nextSelection.engine === 'asa') {
    showToast('ASA 规则只支持 iOS，已自动切换到 iOS。');
  }
  if (appCleared) {
    showToast('当前应用不支持新的平台组合，请重新选择应用。', true);
  }
  loadRecommendationPolicySelection(nextSelection, { step: 1 });
}

function applyRecommendationPolicyTemplate(templateKind) {
  const editor = getRecommendationPolicyEditor();
  if (!isRecommendationPolicySelectionComplete(editor.selection)) {
    showToast('请先选择平台、应用和建议类型，再载入模板。', true);
    return;
  }
  if (!confirmRecommendationPolicyDiscard()) {
    renderRecommendationPolicySelectionFields();
    return;
  }
  const draft = createPolicyTemplate(editor.selection, templateKind);
  setRecommendationPolicyDraftState({
    source: templateKind,
    draft,
    originalRuleJson: editor.originalRuleJson || {},
    step: 1
  });
}

function addRecommendationPolicyChip(kind, value) {
  const editor = getRecommendationPolicyEditor();
  const normalized = String(value || '').trim();
  if (!normalized) {
    return;
  }

  if (kind === 'mediaSources') {
    const nextValues = Array.from(new Set([...(editor.draft.mediaSources || []), normalized]));
    editor.draft.mediaSources = nextValues;
    el.recommendationPolicyMediaSourceDraftInput.value = '';
  } else {
    const numeric = Number(normalized);
    if (!Number.isInteger(numeric) || numeric <= 0) {
      showToast('上下文窗口必须是大于 0 的整数。', true);
      return;
    }
    const nextValues = Array.from(new Set([...(editor.draft.contextWindowDays || []), numeric])).sort(
      (left, right) => left - right
    );
    editor.draft.contextWindowDays = nextValues;
    el.recommendationPolicyContextWindowDraftInput.value = '';
  }

  syncRecommendationPolicyDirtyState();
  renderRecommendationPolicyFieldVisibility();
  renderRecommendationPolicyStatusCopy();
  renderRecommendationPolicyReview();
}

function removeRecommendationPolicyChip(kind, value) {
  const editor = getRecommendationPolicyEditor();
  if (kind === 'mediaSources') {
    editor.draft.mediaSources = (editor.draft.mediaSources || []).filter((item) => item !== value);
  } else {
    editor.draft.contextWindowDays = (editor.draft.contextWindowDays || []).filter((item) => String(item) !== String(value));
  }
  syncRecommendationPolicyDirtyState();
  renderRecommendationPolicyFieldVisibility();
  renderRecommendationPolicyStatusCopy();
  renderRecommendationPolicyReview();
}

function addRecommendationPolicyTargetRow(kind) {
  const editor = getRecommendationPolicyEditor();
  const key = kind === 'country' ? 'countryTargets' : 'mediaTargets';
  editor.draft[key] = [...(editor.draft[key] || []), createEmptyTargetRow(kind)];
  syncRecommendationPolicyDirtyState();
  renderRecommendationPolicyFieldVisibility();
  renderRecommendationPolicyStatusCopy();
  renderRecommendationPolicyReview();
}

function upsertRecommendationPolicyTargetRow(kind, rowId, patch) {
  const editor = getRecommendationPolicyEditor();
  const key = kind === 'country' ? 'countryTargets' : 'mediaTargets';
  editor.draft[key] = (editor.draft[key] || []).map((row) => (row.id === rowId ? { ...row, ...patch } : row));
  syncRecommendationPolicyDirtyState();
  renderRecommendationPolicyStatusCopy();
  renderRecommendationPolicyReview();
}

function copyRecommendationPolicyTargetRow(kind, rowId) {
  const editor = getRecommendationPolicyEditor();
  const key = kind === 'country' ? 'countryTargets' : 'mediaTargets';
  const row = (editor.draft[key] || []).find((item) => item.id === rowId);
  if (!row) {
    return;
  }
  const nextRow = { ...cloneRecommendationPolicyDraft(row), id: createEmptyTargetRow(kind).id };
  editor.draft[key] = [...(editor.draft[key] || []), nextRow];
  syncRecommendationPolicyDirtyState();
  renderRecommendationPolicyFieldVisibility();
  renderRecommendationPolicyStatusCopy();
  renderRecommendationPolicyReview();
}

function removeRecommendationPolicyTargetRow(kind, rowId) {
  const editor = getRecommendationPolicyEditor();
  const key = kind === 'country' ? 'countryTargets' : 'mediaTargets';
  editor.draft[key] = (editor.draft[key] || []).filter((row) => row.id !== rowId);
  syncRecommendationPolicyDirtyState();
  renderRecommendationPolicyFieldVisibility();
  renderRecommendationPolicyStatusCopy();
  renderRecommendationPolicyReview();
}

function changeRecommendationPolicyStep(targetStep) {
  const editor = getRecommendationPolicyEditor();
  const nextStep = Math.min(RECOMMENDATION_POLICY_STEP_COUNT, Math.max(1, Number(targetStep) || 1));
  if (nextStep > 1 && !isRecommendationPolicySelectionComplete(editor.selection)) {
    showToast('请先选择平台、应用和建议类型，再继续下一步。', true);
    editor.step = 1;
    renderRecommendationPolicyStepState();
    return;
  }
  syncRecommendationPolicyDirtyState();
  editor.step = nextStep;
  renderRecommendationPolicyStepState();
  renderRecommendationPolicyReview();
}

function handleRecommendationPolicyScalarInputChange() {
  syncRecommendationPolicyDirtyState();
  renderRecommendationPolicyFieldVisibility();
  renderRecommendationPolicyStatusCopy();
  renderRecommendationPolicyReview();
}

function renderRecommendationPolicies() {
  if (!el.recommendationPoliciesTableBody) {
    return;
  }
  const rows = Array.isArray(state.recommendationPolicies) ? state.recommendationPolicies : [];
  if (rows.length === 0) {
    el.recommendationPoliciesTableBody.innerHTML =
      '<tr><td class="table-empty" colspan="7">还没有已保存规则。先选平台、应用和建议类型，再填写目标和限制条件。</td></tr>';
    return;
  }
  el.recommendationPoliciesTableBody.innerHTML = rows
    .map((row) => {
      const summary = buildRecommendationPolicyTableSummary(row);
      return `
        <tr>
          <td class="table-cell-wrap">
            <strong>${escapeHtml(productViewName(row.app_key, row.platform || 'unknown'))}</strong>
            <div class="hint">${escapeHtml(`${platformLabel(row.platform || 'unknown')} · ${POLICY_ENGINE_LABELS[row.engine] || row.engine}`)}</div>
          </td>
          <td class="table-cell-wrap">${escapeHtml(summary.objective)}</td>
          <td class="table-cell-wrap">${escapeHtml(summary.scope)}</td>
          <td class="table-cell-wrap">${escapeHtml(summary.thresholds)}</td>
          <td class="table-cell-wrap">${escapeHtml(summary.supportLabel)}${summary.supportNote ? `<div class="hint">${escapeHtml(summary.supportNote)}</div>` : ''}</td>
          <td>${escapeHtml(fmtTime(row.updated_at))}</td>
          <td>
            <div class="table-actions">
              <button class="btn btn-ghost btn-compact" type="button" data-policy-key="${escapeHtml(recommendationPolicyKey(row))}">编辑</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

async function loadRecommendationPolicies() {
  const body = await api('/api/recommendation-policies');
  state.recommendationPolicies = Array.isArray(body.data) ? body.data : [];
  renderRecommendationPolicies();
  renderRecommendationPolicyEmptyState();
  const editor = getRecommendationPolicyEditor();
  if (isRecommendationPolicySelectionComplete(editor.selection) && !editor.dirty) {
    loadRecommendationPolicySelection(editor.selection, { step: editor.step });
    return;
  }
  renderRecommendationPolicyEditor();
}

function validateRecommendationPolicyDraftForSave(draft) {
  const selection = draft.selection || {};
  if (!isRecommendationPolicySelectionComplete(selection)) {
    throw new Error('请先选择应用、平台和建议类型。');
  }
  if (selection.engine === 'asa' && selection.platform !== 'ios') {
    throw new Error('ASA 规则只支持 iOS，请先改为 iOS。');
  }
  const app = (state.apps || []).find((item) => item.app_key === selection.appKey);
  if (!appSupportsRecommendationPlatform(app, selection.platform)) {
    throw new Error('当前应用不支持这个平台，请重新选择应用或平台。');
  }
  if (draft.metricFamily === 'relative_compare' && (!Array.isArray(draft.relativeCompare?.metrics) || draft.relativeCompare.metrics.length === 0)) {
    throw new Error('同类对比判断至少勾选 1 项比较指标。');
  }
}

async function saveRecommendationPolicy(event) {
  event.preventDefault();
  syncRecommendationPolicyDirtyState();
  const editor = getRecommendationPolicyEditor();
  const draft = editor.draft;
  const selection = draft.selection;
  validateRecommendationPolicyDraftForSave(draft);

  const ruleJson = mergeRecommendationPolicyRule(editor.originalRuleJson || {}, draft);
  await api('/api/recommendation-policies', {
    method: 'POST',
    body: JSON.stringify({
      appKey: selection.appKey,
      platform: selection.platform,
      engine: selection.engine,
      enabled: draft.enabled,
      ruleJson,
      manualPromptMarkdown: draft.manualPromptMarkdown
    })
  });

  editor.originalRuleJson = cloneRecommendationPolicyDraft(ruleJson);
  editor.originalSnapshot = buildRecommendationPolicySnapshot(draft);
  editor.dirty = false;
  showToast(`已保存该应用的${POLICY_ENGINE_LABELS[selection.engine] || selection.engine}调控规则`);
  await loadRecommendationPolicies();
}

async function handleRecommendationPoliciesTableClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const policyKey = String(target.dataset.policyKey || '').trim();
  if (!policyKey) {
    return;
  }
  const row = (state.recommendationPolicies || []).find((item) => recommendationPolicyKey(item) === policyKey);
  if (!row) {
    return;
  }
  if (!confirmRecommendationPolicyDiscard()) {
    return;
  }
  loadRecommendationPolicySelection(
    {
      platform: row.platform,
      appKey: row.app_key,
      engine: row.engine
    },
    { step: 2 }
  );
  showToast(`已载入 ${productViewName(row.app_key, row.platform || 'unknown')} 的当前已保存规则`);
  scrollToSection('section-budget', true);
}

function handleRecommendationPolicyTargetInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  const kind = String(target.dataset.policyTargetKind || '').trim();
  const rowId = String(target.dataset.policyTargetRowId || '').trim();
  if (!kind || !rowId) {
    return;
  }
  if (target.dataset.policyTargetKey === 'true') {
    upsertRecommendationPolicyTargetRow(kind, rowId, { key: target.value });
    return;
  }
  const field = String(target.dataset.policyTargetField || '').trim();
  if (!field) {
    return;
  }
  upsertRecommendationPolicyTargetRow(kind, rowId, { [field]: target.value });
}

async function loadApps() {
  const body = await api('/api/apps');
  state.apps = body.data || [];
  renderApps();
  populateAppSelects();
  syncAsaStageFormSelection();
  renderRecommendationPolicyEditor();
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
    throw new Error('请至少填写一个应用 ID（iOS / Android / 兼容应用 ID）');
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

  showToast(existed ? `应用设置已更新：${appKey}` : `应用设置已创建：${appKey}`);
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
  showToast(`正在编辑应用：${editAppKey}`);
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

  if (state.rules.length === 0) {
    el.rulesList.innerHTML = '<div class="hint">当前还没有已保存规则。</div>';
    return;
  }

  el.rulesList.innerHTML = state.rules
    .map(
      (rule) => `
        <div class="rule-row">
          <div class="rule-row-head">
            <strong>${rule.name}</strong>
            <span class="badge ${rule.enabled ? 'badge-P2' : 'badge-P0'}">${rule.enabled ? '已启用' : '已停用'}</span>
          </div>
          <div class="hint">应用标识 ${rule.app_key} · 更新时间 ${fmtTime(rule.updated_at)}</div>
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
    setRulesSectionExpanded(true);
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
            <button class="btn btn-ghost btn-compact" data-alert-id="${a.id}" type="button">查看说明</button>
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
    `告警编号 ${alert.id} · 应用标识 ${alert.app_key} · 指标 ${metricLabel(alert.metric)} · 状态 ${statusLabel(alert.status)} · 等级 ${severityLabel(alert.severity)} · 创建时间 ${fmtTime(alert.created_at)}`;
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
      '<tr><td class="table-empty" colspan="12">当前筛选条件下暂无广告日报记录</td></tr>';
    return;
  }

  const html = [];
  rows.forEach((row, idx) => {
    const rowKey = pullRowKey(row, idx);
    const expanded = rowKey === state.expandedPullRowKey;
    const actionText = expanded ? '收起技术详情' : '查看技术详情';

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
            <button class="btn btn-ghost btn-compact" type="button" data-pull-delete-key="${escapeHtml(rowKey)}">删除记录</button>
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
    `开始时间 ${started} · 结束时间 ${ended} · 耗时 ${duration}ms · 成功 ${successCount} · 失败 ${failedCount} · 跳过 ${skippedCount}`;

  const lines = details.map((item) => {
    const appKey = item.app_key || '-';
    const platform = platformLabel(item.platform || 'unknown');
    const date = item.date || '-';
    const status = item.status ? statusLabel(item.status) : '-';
    const rows = Number(item.rows || 0);
    const metricsRows = Number(item.metrics_rows || 0);
    const error = item.error ? ` · 错误信息 ${item.error}` : '';
    return `应用标识 ${appKey} · 平台 ${platform} · 日期 ${date} · 状态 ${status} · 记录数 ${rows} · 指标行数 ${metricsRows}${error}`;
  });
  el.pullResultDetail.textContent = lines.length > 0 ? lines.join('\n') : '没有可展示的拉取明细';
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
    { label: '每次安装成本（eCPI）', value: `$${toFixed2(summary.blended_ecpi || 0)}` },
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
                  `成本 $${toFixed2(row.total_cost)} ｜ 每次安装成本（eCPI） $${toFixed2(row.blended_ecpi)}`
                ]
              })
            )
          : [{ title: '暂无数据', source: '-', lines: ['当前日期暂无广告日报汇总数据。'] }]
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
                    ? '收入回收数据待补齐，当前仍按每次安装成本（eCPI）生成建议'
                    : `当前每次安装成本（eCPI） $${toFixed2(row.current_ecpi)} ｜ 目标 $${toFixed2(row.target_ecpi)}`;
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
  const deliveryStatus = notify?.ok
    ? renderMode === 'text_fallback'
      ? '已回退为文本发送'
      : skipped
        ? '今日已发送，已跳过重复发送'
        : '已发送到飞书'
    : '发送失败';
  el.dailyBriefMeta.textContent =
    `报告日期 ${report.report_date || '-'} · 产品 ${summary.app_count || 0} 个 · 覆盖 ${summary.apps_with_data || 0} 个 · 安装 ${toFixed2(summary.total_installs || 0)} · 成本 ${toFixed2(summary.total_cost || 0)} · 待处理预算 ${summary.pending_budget_actions || 0} · 建议操作 ${actionItems.length}` +
    (dispatch?.sent_at ? ` · 最近发送 ${fmtTime(dispatch.sent_at)}` : '') +
    (notify || skipped ? ` · ${deliveryStatus}` : '');
  el.dailyBriefHeroTitle.textContent = String(report.title || '每日简报');
  el.dailyBriefRenderBadge.textContent =
    renderMode === 'text_fallback' ? '文本消息' : '卡片消息';
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
    el.runtimeSchedulePullSummary.textContent = `广告日报与 ASA 数据将在 ${pullTime} 开始准备。`;
  }
  if (el.runtimeSchedulePushSummary) {
    el.runtimeSchedulePushSummary.textContent = `每日简报与 ASA 简报将在 ${pushTime} 发送，执行表会顺延到 ${bitableTime}。`;
  }
  if (el.runtimeScheduleStatus) {
    el.runtimeScheduleStatus.textContent = `当前时间安排：数据准备 ${pullTime} ｜ 消息发送 ${pushTime} ｜ 执行表 ${bitableTime} ｜ 时区 ${timezoneLabel(timezone)} ｜ 最近更新 ${updatedAt}`;
  }
  if (el.bitableSchedulePrimaryNote) {
    el.bitableSchedulePrimaryNote.textContent = `每日 ${bitableTime}（北京时间）自动执行。系统会在同一飞书多维表格中按日期创建或复用当天的「投放执行表」，同日重跑刷新当天内容，历史日期自动留档。`;
  }
}

function renderRuntimeSchedulePreview() {
  const pullTime = String(el.runtimePullTimeInput?.value || '09:00').trim() || '09:00';
  const pushTime = String(el.runtimePushTimeInput?.value || '10:00').trim() || '10:00';
  const bitableTime = addMinutesToTimeValue(pushTime, 5);

  if (el.runtimeSchedulePullSummary) {
    el.runtimeSchedulePullSummary.textContent = `广告日报与 ASA 数据将在 ${pullTime} 开始准备。`;
  }
  if (el.runtimeSchedulePushSummary) {
    el.runtimeSchedulePushSummary.textContent = `每日简报与 ASA 简报将在 ${pushTime} 发送，执行表会顺延到 ${bitableTime}。`;
  }
  if (el.bitableSchedulePrimaryNote) {
    el.bitableSchedulePrimaryNote.textContent = `每日 ${bitableTime}（北京时间）自动执行。系统会在同一飞书多维表格中按日期创建或复用当天的「投放执行表」，同日重跑刷新当天内容，历史日期自动留档。`;
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
    throw new Error('请输入有效的数据准备时间');
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
    showToast(`已更新时间安排：数据准备 ${pullTime} / 消息发送 ${pushTime}`);
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
  state.dailyBriefPreviewPayload = body.data || null;
  state.dailyBriefPreviewLoadedAt = new Date().toISOString();
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
    state.dailyBriefPreviewPayload = body.data || null;
    state.dailyBriefPreviewLoadedAt = new Date().toISOString();
    renderDailyBriefModal(body.data, 'send');
    el.dailyBriefStatus.textContent = `日报已发送到飞书：${reportDate}`;
    showToast('每日简报已发送到飞书');
  } finally {
    el.sendDailyBriefBtn.disabled = false;
    el.sendDailyBriefBtn.textContent = originalText;
  }
}

function bitableExportStatusLabel(status) {
  const mapping = {
    idle: '未执行',
    success: '成功',
    failed: '失败',
    partial_success: '部分成功'
  };
  return mapping[status] || status || '-';
}

function bitableExportStatusBadgeClass(status) {
  if (status === 'success') return 'badge-open';
  if (status === 'partial_success') return 'badge-P1';
  if (status === 'failed') return 'badge-P0';
  return 'badge-P2';
}

function renderBitableExportCards() {
  const sources = Array.isArray(state.bitableExportSources) ? state.bitableExportSources : [];
  if (!el.bitableExportCards) {
    return;
  }

  if (sources.length === 0) {
    el.bitableExportCards.innerHTML = '<div class="hint">正在加载投放执行表配置...</div>';
    return;
  }

  el.bitableExportCards.innerHTML = sources
    .map((source) => {
      const config = source.config || {};
      const selected = Array.isArray(config.selected_fields) ? config.selected_fields : [];
      const tableNamePrefix = String(config.table_name_prefix || source.label || '').trim();
      const recentTables = Array.isArray(source.recent_tables) ? source.recent_tables : [];
      const latestTable = recentTables[0] || null;
      const targetTableName = String(config.target_table_name || latestTable?.table_name || '').trim();
      const targetTableId = String(config.target_table_id || '').trim();
      const tableUrl = String(source.latest_table_url || source.table_url || latestTable?.table_url || '').trim();
      const lastStatus = String(config.last_status || 'idle');
      const lastError = String(config.last_error || '').trim();
      const feedbackSync = source.feedback_sync || {};
      const feedbackStatus = String(feedbackSync.last_status || 'idle');
      const feedbackError = String(feedbackSync.last_error || '').trim();
      const chatId = String(config.chat_id || '').trim();
      const isEnabled = config.enabled === true;
      const fieldLabels = Array.isArray(source.fields) ? source.fields.map((field) => String(field.label || '').trim()).filter(Boolean) : [];
      const outputPreview = fieldLabels.slice(0, 8);

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
              <span class="bitable-export-target-label">最近同步表</span>
              <strong>${escapeHtml(targetTableName || '尚未生成日期表')}</strong>
            </div>
            <div class="bitable-export-target-meta">
              <span class="table-cell-mono">${escapeHtml(targetTableId || '首次执行时按日期创建')}</span>
              ${
                tableUrl
                  ? `<a class="btn btn-ghost btn-compact" href="${escapeHtml(tableUrl)}" target="_blank" rel="noreferrer">打开表格</a>`
                  : ''
              }
            </div>
          </div>

          <div class="bitable-export-config-grid">
            <label class="filter-field">
              <span class="field-label">表名前缀</span>
              <input type="text" data-role="table-name-prefix" value="${escapeHtml(tableNamePrefix || '')}" placeholder="例如 投放执行表" />
            </label>
            <label class="filter-field">
              <span class="field-label">飞书群 ID</span>
              <input type="text" data-role="chat-id" value="${escapeHtml(chatId)}" placeholder="例如 oc_xxx" />
            </label>
          </div>

          <div class="bitable-export-field-block bitable-export-field-block-static">
            <div class="bitable-export-field-head">
              <strong>执行表字段</strong>
              <span class="hint">固定输出 ${selected.length || fieldLabels.length}/${fieldLabels.length} 列</span>
            </div>
            <div class="bitable-field-grid bitable-field-grid-static">
              ${outputPreview
                .map((label) => `<span class="bitable-field-pill">${escapeHtml(label)}</span>`)
                .join('')}
              ${
                fieldLabels.length > outputPreview.length
                  ? `<span class="bitable-field-pill bitable-field-pill-muted">以及另外 ${fieldLabels.length - outputPreview.length} 列</span>`
                  : ''
              }
            </div>
            <p class="hint">系统固定输出投放项名称（飞书主字段）、产品名、主指标、当前/目标表现、量级参考、建议动作、建议理由、执行状态、是否采纳、人工批复，以及“七天后数据（系统自动回填）”。</p>
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
            <div class="bitable-export-status-row">
              <span>反馈回读</span>
              <strong><span class="badge ${bitableExportStatusBadgeClass(feedbackStatus)}">${escapeHtml(
                bitableExportStatusLabel(feedbackStatus)
              )}</span></strong>
            </div>
            <div class="bitable-export-status-row">
              <span>最近回读时间</span>
              <strong>${escapeHtml(fmtTime(feedbackSync.last_synced_at))}</strong>
            </div>
            <div class="bitable-export-status-row">
              <span>最近回读记录数</span>
              <strong>${escapeHtml(String(feedbackSync.last_record_count || 0))}</strong>
            </div>
            <div class="bitable-export-status-row">
              <span>最近回读错误</span>
              <strong class="${feedbackError ? 'bitable-error-text' : ''}">${escapeHtml(feedbackError || '无')}</strong>
            </div>
            <div class="bitable-export-status-row">
              <span>最新 skills</span>
              <strong>${escapeHtml(fmtTime(feedbackSync.latest_skill_updated_at))}</strong>
            </div>
          </div>

          <div class="bitable-export-history">
            <div class="bitable-export-history-head">
              <strong>最近历史表</strong>
              <span class="hint">默认展示最近 7 天归档</span>
            </div>
            ${
              recentTables.length
                ? `<div class="bitable-export-history-list">
                    ${recentTables
                      .map(
                        (item) => `
                          <div class="bitable-export-history-item">
                            <div class="bitable-export-history-main">
                              <strong>${escapeHtml(String(item.report_date || '-'))}</strong>
                              <span>${escapeHtml(String(item.table_name || '-'))}</span>
                            </div>
                            <div class="bitable-export-history-meta">
                              <span>${escapeHtml(`记录 ${Number(item.last_record_count || 0)}`)}</span>
                              <span>${escapeHtml(fmtTime(item.last_synced_at))}</span>
                              ${
                                item.table_url
                                  ? `<a class="btn btn-ghost btn-compact" href="${escapeHtml(String(item.table_url || ''))}" target="_blank" rel="noreferrer">打开</a>`
                                  : ''
                              }
                            </div>
                          </div>
                        `
                      )
                      .join('')}
                  </div>`
                : '<div class="hint">尚未生成按日期留档的执行表。</div>'
            }
          </div>

          <div class="bitable-export-actions">
            <button class="btn btn-secondary" type="button" data-role="save-config">保存配置</button>
            <button class="btn btn-secondary" type="button" data-role="sync-feedback">立即回读反馈</button>
            <button class="btn btn-primary" type="button" data-role="run-export">立即更新并推送</button>
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
  const tableNamePrefixInput = card.querySelector('[data-role="table-name-prefix"]');

  return {
    enabled: enabledInput instanceof HTMLInputElement ? enabledInput.checked : false,
    chatId: chatIdInput instanceof HTMLInputElement ? String(chatIdInput.value || '').trim() : '',
    tableNamePrefix:
      tableNamePrefixInput instanceof HTMLInputElement ? String(tableNamePrefixInput.value || '').trim() : ''
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
    label.textContent = total > 0 ? `已选 ${checked}/${total} 列` : '固定输出字段';
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
  showToast(`${next?.label || '投放执行表'} 配置已保存`);
}

async function runBitableExportCard(sourceType) {
  const reportDate = String(el.bitableExportReportDateInput?.value || '').trim();
  if (!reportDate) {
    throw new Error('请先选择手动导出日期');
  }

  const button = findBitableExportCard(sourceType)?.querySelector('[data-role="run-export"]');
  const originalText = button instanceof HTMLButtonElement ? button.textContent || '立即更新并推送' : '';
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
    button.textContent = '更新中...';
  }

  try {
    const body = await api('/api/bitable-exports/run', {
      method: 'POST',
      body: JSON.stringify({ sourceType, reportDate })
    });
    const result = body.data || {};
    await Promise.all([
      loadBitableExportConfigs(),
      loadOperationLogs(),
      loadBudgetRecommendations(undefined, state.budgetPage || 1)
    ]);
    showToast(
      result.export_status === 'partial_success'
        ? `${result.label || '投放执行表'} 已刷新 ${result.record_count || 0} 条执行项，但旧快照清理不完整`
        : `${result.label || '投放执行表'} 已刷新 ${result.record_count || 0} 条执行项`
    );
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function syncBitableFeedbackCard(sourceType) {
  const button = findBitableExportCard(sourceType)?.querySelector('[data-role="sync-feedback"]');
  const originalText = button instanceof HTMLButtonElement ? button.textContent || '立即回读反馈' : '';
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
    button.textContent = '回读中...';
  }

  try {
    const body = await api('/api/bitable-exports/feedback-sync', {
      method: 'POST',
      body: JSON.stringify({ sourceType })
    });
    const result = body.data || {};
    await Promise.all([loadBitableExportConfigs(), loadBudgetRecommendations(undefined, state.budgetPage || 1)]);
    showToast(
      `执行反馈已回读 ${Number(result.synced_count || 0)} 条，忽略 ${Number(result.skipped_count || 0)} 条无映射记录`
    );
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function currentExecutionTableUrl() {
  const source = (state.bitableExportSources || []).find((item) => item.source_type === 'delivery_actions');
  return String(source?.table_url || '').trim();
}

async function exportBudgetFeedbackData() {
  const form = new FormData(el.budgetFilter);
  const params = new URLSearchParams();
  ['appKey', 'platform', 'from', 'to', 'status', 'executionStatus', 'isAdopted', 'hasManualReview'].forEach((key) => {
    const value = String(form.get(key) || '').trim();
    if (value) {
      params.set(key, value);
    }
  });
  window.open(`/api/budget/recommendations/feedback-export?${params.toString()}`, '_blank', 'noopener');
}

async function downloadLatestBudgetSkills() {
  const body = await api('/api/budget/recommendations/skills/latest');
  const latest = body.data || null;
  if (!latest) {
    throw new Error('当前还没有可下载的 skills.md');
  }
  window.open('/api/budget/recommendations/skills/latest/download', '_blank', 'noopener');
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
  state.pullRecordsLoadedAt = new Date().toISOString();
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
    throw new Error('未找到对应的广告日报记录');
  }

  const confirmed = window.confirm(
    `确认删除这条广告日报记录？\n应用标识：${row.app_key}\n日期：${row.date}\n媒体源：${row.media_source}\n广告系列：${row.campaign}`
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

  showToast('广告日报记录已删除');
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

  const originalText = el.triggerPullBtn.textContent || '手动拉取数据';
  el.triggerPullBtn.disabled = true;
  el.triggerPullBtn.textContent = '拉取中...';

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
      showToast('手动拉取完成');
    } else if (successCount === 0 && failedCount === 0 && skippedCount > 0) {
      showToast('本次未发起实际拉取，已命中跳过策略');
    } else if (successCount > 0) {
      showToast('手动拉取完成，部分条目已跳过或失败');
    } else {
      showToast('手动拉取完成，但全部失败或被跳过', true);
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
  state.keywordLoadedAt = new Date().toISOString();
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
    `产品视图 ${productViewName(row.app_key, row.platform || 'unknown')} · 应用标识 ${row.app_key} · 平台 ${platformLabel(row.platform || 'unknown')} · 关键词 ${row.keyword} · 匹配方式 ${matchTypeLabel(row.match_type || 'unknown')} · 当前阶段 ${lifecycleStageLabel(row.current_stage)} · 已处于该阶段 ${row.days_in_stage} 天`;
  const last = trendRows.at(-1);
  el.keywordTrendLegend.textContent = `数据点 ${trendRows.length} · 最新安装量 ${toFixed2(last?.installs)} · 最新每次安装成本 ${toFixed2(last?.cpi)}`;
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
      '<tr><td class="table-empty" colspan="19">当前筛选条件下暂无预算建议</td></tr>';
    return;
  }

  el.budgetTableBody.innerHTML = rows
    .map((row) => {
      const manualReview = String(row.validation_result || '').trim();
      const executionTableUrl = currentExecutionTableUrl();
      const executionActionSummary = formatBudgetExecutionActionSummary(row);
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
        <td class="table-cell-wrap">${escapeHtml(executionActionSummary || '-')}</td>
        <td>${(Number(row.confidence || 0) * 100).toFixed(1)}%</td>
        <td><span class="badge badge-${escapeHtml(row.status)}">${budgetStatusLabel(row.status)}</span></td>
        <td>${escapeHtml(String(row.execution_status || '未填写'))}</td>
        <td>${row.is_adopted ? '已采纳' : '未采纳 / 未勾选'}</td>
        <td class="table-cell-wrap">${escapeHtml(manualReview ? `${manualReview.slice(0, 36)}${manualReview.length > 36 ? '...' : ''}` : '-')}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-ghost btn-compact" type="button" data-budget-view-id="${row.id}">查看说明</button>
            ${
              executionTableUrl
                ? `<a class="btn btn-ghost btn-compact" href="${escapeHtml(executionTableUrl)}" target="_blank" rel="noreferrer">前往执行表</a>`
                : ''
            }
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
  const executionStatus = String(form.get('executionStatus') || '').trim();
  const isAdopted = String(form.get('isAdopted') || '').trim();
  const hasManualReview = String(form.get('hasManualReview') || '').trim();
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
  if (executionStatus) params.set('executionStatus', executionStatus);
  if (isAdopted) params.set('isAdopted', isAdopted);
  if (hasManualReview) params.set('hasManualReview', hasManualReview);

  const body = await api(`/api/budget/recommendations?${params.toString()}`);
  state.budgetRows = Array.isArray(body.data) ? body.data : [];
  state.budgetLoadedAt = new Date().toISOString();
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
  const executionActionSummary = formatBudgetExecutionActionSummary(row, llmSummary);
  const actionItems = Array.isArray(llmSummary.action_items) && llmSummary.action_items.length > 0
    ? llmSummary.action_items
    : executionActionSummary
      ? executionActionSummary.split(' / ')
      : [];
  const checklist = Array.isArray(llmSummary.checklist) ? llmSummary.checklist : [];
  const points = Array.isArray(llmSummary.explanation_points) ? llmSummary.explanation_points : [];
  const scenarioTagSummary = formatBudgetScenarioTagSummary(row, llmSummary);

  el.budgetDetailTitle.textContent = `预算建议说明 · ${productViewName(row.app_key, row.platform || 'unknown')} · ${row.keyword}`;
  el.budgetDetailSummary.textContent = String(llmSummary.summary_cn || row.reason_code || '暂无补充说明');
  el.budgetDetailDisplayName.textContent = productViewName(row.app_key, row.platform || 'unknown');
  el.budgetDetailMediaSource.textContent = String(row.media_source || '-');
  el.budgetDetailPrimaryMetric.textContent = primaryMetricLabel(row.primary_metric || 'ecpi');
  el.budgetDetailMetricMode.textContent = metricModeLabel(row.metric_mode || 'active', row.roas_data_status);
  el.budgetDetailTier.textContent = volumeTierLabel(row.volume_tier);
  el.budgetDetailEcpi.textContent = toFixed2(row.current_ecpi);
  el.budgetDetailTargetEcpi.textContent = toFixed2(row.target_ecpi);
  const budgetRoasSourceMeta = buildRoasSourceMetaText(row.roas_primary_source, row.roas_warning_code);
  el.budgetDetailCurrentRoas.textContent =
    row.roas_data_status === 'pending'
      ? `待补齐（源数据缺失）｜${budgetRoasSourceMeta}`
      : row.roas_data_status === 'partial'
        ? row.current_roas == null
          ? `覆盖率达阈值（按已覆盖成本计算）｜${budgetRoasSourceMeta}`
          : `${formatRoasPercent(row.current_roas)}（按已覆盖成本计算）｜${budgetRoasSourceMeta}`
      : row.roas_data_status === 'partial_low'
        ? row.current_roas == null
          ? `覆盖率偏低（仅供参考）｜${budgetRoasSourceMeta}`
          : `${formatRoasPercent(row.current_roas)}（覆盖率偏低，仅供参考）｜${budgetRoasSourceMeta}`
      : row.roas_data_status === 'unavailable'
        ? `暂无成熟数据｜${budgetRoasSourceMeta}`
        : row.current_roas == null
          ? '-'
          : `${formatRoasPercent(row.current_roas)}｜${budgetRoasSourceMeta}`;
  el.budgetDetailTargetRoas.textContent = row.target_roas == null ? '-' : formatRoasPercent(row.target_roas);
  el.budgetDetailBudgetAction.textContent = actionLabel(row.action);
  el.budgetDetailExecutionActions.textContent = executionActionSummary || '-';
  el.budgetDetailScenarioTags.textContent = scenarioTagSummary || '-';
  el.budgetDetailCurrentCost.textContent = toFixed2(row.current_cost);
  el.budgetDetailSuggestedBudget.textContent = toFixed2(row.suggested_budget);
  el.budgetDetailChangeRatio.textContent = `${(Number(row.change_ratio || 0) * 100).toFixed(1)}%`;
  el.budgetDetailExecutionStatus.textContent = String(row.execution_status || '未填写');
  el.budgetDetailIsAdopted.textContent = row.is_adopted ? '已采纳' : '未采纳 / 未勾选';
  el.budgetDetailFeedbackSyncedAt.textContent = fmtTime(row.feedback_synced_at);
  el.budgetDetailValidationResult.textContent = String(row.validation_result || '-');
  el.budgetDetailRisk.textContent = String(llmSummary.risk_level || '-');
  el.budgetDetailActionItems.innerHTML = actionItems.map((item) => `<li>${escapeHtml(String(item))}</li>`).join('');
  el.budgetDetailChecklist.innerHTML = checklist.map((item) => `<li>${escapeHtml(String(item))}</li>`).join('');
  el.budgetDetailPoints.innerHTML = points.map((item) => `<li>${escapeHtml(String(item))}</li>`).join('');
  el.budgetDetailRaw.textContent = JSON.stringify(llmSummary, null, 2);
  setBudgetDetailModalOpen(true);
}

async function handleBudgetTableClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const viewId = Number(target.dataset.budgetViewId || 0);

  if (viewId) {
    const row = state.budgetRows.find((item) => Number(item.id) === viewId);
    if (row) {
      openBudgetDetail(row);
    }
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
  state.asaSummary = summary && typeof summary === 'object' ? { ...summary } : {};
  const totalCost = Number(summary.total_cost || 0);
  const installs = Number(summary.installs || 0);
  el.asaSummaryKeywordCount.textContent = String(summary.keyword_count || 0);
  el.asaSummaryInstalls.textContent = toFixed2(summary.installs || 0);
  el.asaSummaryCost.textContent = `$${toFixed2(summary.total_cost || 0)}`;
  el.asaSummaryEcpi.textContent = totalCost > 0 && installs <= 0 ? '—' : `$${toFixed2(summary.ecpi || 0)}`;
  el.asaSummaryCpp.innerHTML = buildAsaCppMetricStackHtml(summary);
  el.asaSummaryRoas.innerHTML = buildAsaD7RoasMetricStackHtml(summary);
  el.asaSummaryCpp.title = buildAsaCppMetricTitle(summary);
  el.asaSummaryRoas.title = buildAsaD7RoasMetricTitle(summary);
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

function normalizeRoasDataStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'complete' || status === 'partial' || status === 'partial_low' || status === 'pending' || status === 'unavailable') {
    return status;
  }
  return 'unavailable';
}

function isAsaRoasDisplayableStatus(value) {
  const status = normalizeRoasDataStatus(value);
  return status === 'complete' || status === 'partial' || status === 'partial_low';
}

function normalizeRoasCoverageRatio(value, roasDataStatus) {
  const ratio = Number(value || 0);
  if (Number.isFinite(ratio) && ratio > 0) {
    return Math.min(1, Math.max(0, ratio));
  }
  return normalizeRoasDataStatus(roasDataStatus) === 'complete' ? 1 : 0;
}

function formatRoasPrimarySourceLabel(source) {
  return String(source || '') === 'af_cohort' ? 'AF Cohort 主口径' : '本地回退口径';
}

function formatRoasWarningLabel(code) {
  const value = String(code || '').trim();
  if (value === 'af_missing') {
    return 'AF 缺失，当前为本地派生';
  }
  if (value === 'af_vs_local_mismatch') {
    return 'AF 与本地派生偏差较大';
  }
  if (value === 'af_grain_unavailable') {
    return '当前粒度无 AF 官方 ROAS';
  }
  return '';
}

function buildRoasSourceMetaText(primarySource, warningCode) {
  const sourceLabel = formatRoasPrimarySourceLabel(primarySource);
  const warningLabel = formatRoasWarningLabel(warningCode);
  return warningLabel ? `${sourceLabel} · ${warningLabel}` : sourceLabel;
}

function formatAsaCoverageMeta(roasDataStatus, coverageRatio) {
  const status = normalizeRoasDataStatus(roasDataStatus);
  const ratio = normalizeRoasCoverageRatio(coverageRatio, roasDataStatus);
  if (ratio > 0) {
    return `覆盖 ${Math.round(ratio * 100)}%`;
  }
  if (status === 'partial') return '覆盖达阈值';
  if (status === 'partial_low') return '覆盖偏低';
  if (status === 'pending') return '待补齐';
  if (status === 'complete') return '覆盖 100%';
  return '暂无成熟数据';
}

function buildAsaCoverageTitle(roasDataStatus, coverageRatio) {
  const status = normalizeRoasDataStatus(roasDataStatus);
  const ratio = normalizeRoasCoverageRatio(coverageRatio, status);
  const ratioText = ratio > 0 ? `Cohort 数据覆盖率 ${Math.round(ratio * 100)}%` : '';
  if (status === 'complete') {
    return ratioText || 'Cohort 数据覆盖完整，当前值可直接使用';
  }
  if (status === 'partial') {
    return ratioText ? `${ratioText}，当前值按已覆盖成本计算` : 'Cohort 覆盖率已达可采纳阈值，当前值按已覆盖成本计算';
  }
  if (status === 'partial_low') {
    return ratioText ? `${ratioText}，覆盖率偏低，当前值仅供参考` : 'Cohort 覆盖率偏低，当前值仅供参考';
  }
  if (status === 'pending') {
    return ratioText ? `${ratioText}，数据仍在补齐，当前值暂不展示` : 'Cohort 源数据仍在补齐，当前值暂不展示';
  }
  return ratioText ? `${ratioText}，覆盖仍偏低，当前值暂不展示` : '当前没有可用的成熟窗口 D7 数据';
}

function buildAsaMetricStackHtml(metaText, valueText) {
  return `
    <span class="metric-stack">
      <span class="metric-stack-meta">${escapeHtml(metaText)}</span>
      <span class="metric-stack-value">${escapeHtml(valueText)}</span>
    </span>
  `;
}

function buildAsaMetricDisplaySource(source = {}) {
  const roasDataStatus = normalizeRoasDataStatus(source.roas_data_status);
  const explicitPrimarySource = String(source.roas_primary_source || '').trim();
  const explicitWarningCode = String(source.roas_warning_code || '').trim();
  const afCohortMissing = Number(source.af_cohort_roas_missing || 0) === 1;
  const localMissing = Number(source.roas_source_missing || 0) === 1;
  const hasAfCohortRoas = source.af_cohort_roas != null && !afCohortMissing && Number.isFinite(Number(source.af_cohort_roas));
  const hasLocalDerivedRoas =
    (source.local_derived_roas ?? source.d7_roas ?? source.current_d7_roas) != null &&
    !localMissing &&
    Number.isFinite(Number(source.local_derived_roas ?? source.d7_roas ?? source.current_d7_roas));
  const roasPrimarySource =
    explicitPrimarySource || (hasAfCohortRoas ? 'af_cohort' : 'local_fallback');
  const roasWarningCode =
    explicitWarningCode || (!hasAfCohortRoas && hasLocalDerivedRoas ? 'af_missing' : 'none');
  const afCohortRoas = hasAfCohortRoas ? Number(source.af_cohort_roas) : 0;
  const localDerivedRoas = hasLocalDerivedRoas
    ? Number(source.local_derived_roas ?? source.d7_roas ?? source.current_d7_roas)
    : 0;
  const d7Roas =
    roasPrimarySource === 'af_cohort'
      ? (hasAfCohortRoas ? afCohortRoas : Number((source.d7_roas ?? source.current_d7_roas) || 0))
      : localDerivedRoas;
  return {
    roasDataStatus,
    roasDisplayable: isAsaRoasDisplayableStatus(roasDataStatus),
    roasCoverageRatio: normalizeRoasCoverageRatio(source.roas_coverage_ratio, roasDataStatus),
    roasPrimarySource,
    roasWarningCode,
    totalCost: Number((source.total_cost ?? source.total_cost_7d) || 0),
    purchaseCount: Number((source.purchase_count ?? source.purchase_count_7d) || 0),
    revenueD7: Number((source.revenue_d7 ?? source.revenue_d7_7d) || 0),
    cpp: Number((source.cpp ?? source.current_cpp) || 0),
    d7Roas
  };
}

function buildAsaTrendMetricDisplaySource(source = {}) {
  const explicitPrimarySource = String(source.roas_primary_source || '').trim();
  const explicitWarningCode = String(source.roas_warning_code || '').trim();
  const afCohortMissing = Number(source.af_cohort_roas_missing || 0) === 1;
  const localMissing = Number(source.roas_source_missing || 0) === 1;
  const totalCost = Number(source.total_cost || 0);
  const purchaseCount = Number(source.purchase_count || 0);
  const revenueD7 = Number(source.revenue_d7 || 0);
  const hasAfCohortRoas = source.af_cohort_roas != null && !afCohortMissing && Number.isFinite(Number(source.af_cohort_roas));
  const hasLocalDerivedRoas = source.d7_roas != null && !localMissing && Number.isFinite(Number(source.d7_roas));
  const roasPrimarySource = explicitPrimarySource || (hasAfCohortRoas ? 'af_cohort' : 'local_fallback');
  const roasWarningCode =
    explicitWarningCode || (!hasAfCohortRoas && hasLocalDerivedRoas ? 'af_missing' : 'none');
  const d7Roas =
    roasPrimarySource === 'af_cohort'
      ? (hasAfCohortRoas ? Number(source.af_cohort_roas) : hasLocalDerivedRoas ? Number(source.d7_roas) : 0)
      : hasLocalDerivedRoas
        ? Number(source.d7_roas)
        : 0;
  const roasStatus =
    totalCost <= 0 ? 'unavailable' : hasAfCohortRoas || hasLocalDerivedRoas ? 'complete' : 'pending';
  const cppStatus = totalCost <= 0 ? 'unavailable' : localMissing ? 'pending' : 'complete';
  return {
    roasPrimarySource,
    roasWarningCode,
    totalCost,
    purchaseCount,
    revenueD7,
    d7Roas,
    roasStatus,
    cppStatus
  };
}

function buildAsaCppMetricTitle(source = {}) {
  const metric = buildAsaMetricDisplaySource(source);
  let title = buildAsaCoverageTitle(metric.roasDataStatus, metric.roasCoverageRatio);
  if (metric.roasDisplayable && metric.totalCost > 0 && metric.purchaseCount <= 0) {
    title = title ? `${title}；覆盖窗口内无购买` : '覆盖窗口内无购买';
  }
  const sourceMeta = buildRoasSourceMetaText(metric.roasPrimarySource, metric.roasWarningCode);
  title = title ? `${title}；${sourceMeta}` : sourceMeta;
  return title;
}

function buildAsaD7RoasMetricTitle(source = {}) {
  const metric = buildAsaMetricDisplaySource(source);
  let title = buildAsaCoverageTitle(metric.roasDataStatus, metric.roasCoverageRatio);
  if (metric.roasDisplayable && metric.totalCost > 0 && metric.revenueD7 <= 0) {
    title = title ? `${title}；覆盖窗口内未观察到 D7 收入` : '覆盖窗口内未观察到 D7 收入';
  }
  const sourceMeta = buildRoasSourceMetaText(metric.roasPrimarySource, metric.roasWarningCode);
  title = title ? `${title}；${sourceMeta}` : sourceMeta;
  return title;
}

function buildAsaCppMetricStackHtml(source = {}) {
  const metric = buildAsaMetricDisplaySource(source);
  const valueText =
    !metric.roasDisplayable
      ? '—'
      : metric.purchaseCount > 0
        ? `$${toFixed2(metric.cpp)}`
        : metric.totalCost > 0
          ? '—'
          : '-';
  return buildAsaMetricStackHtml(
    `${formatAsaCoverageMeta(metric.roasDataStatus, metric.roasCoverageRatio)} · ${formatRoasPrimarySourceLabel(metric.roasPrimarySource)}`,
    valueText
  );
}

function buildAsaD7RoasMetricStackHtml(source = {}) {
  const metric = buildAsaMetricDisplaySource(source);
  const valueText = !metric.roasDisplayable ? '—' : metric.totalCost > 0 ? formatRoasPercent(metric.d7Roas) : '-';
  return buildAsaMetricStackHtml(
    `${formatAsaCoverageMeta(metric.roasDataStatus, metric.roasCoverageRatio)} · ${formatRoasPrimarySourceLabel(metric.roasPrimarySource)}`,
    valueText
  );
}

function formatAsaEcpiDisplay(value, totalCost, installs, options = {}) {
  const withCurrency = options.withCurrency !== false;
  if (asaHasSpendWithoutInstalls(totalCost, installs)) {
    return '—';
  }
  return withCurrency ? `$${toFixed2(value || 0)}` : `${toFixed2(value || 0)}`;
}

function formatRoasPercent(value) {
  return `${toFixed2((Number(value || 0) * 100))}%`;
}

function formatAsaEcpiDisplayWithReason(value, totalCost, installs, options = {}) {
  const withCurrency = options.withCurrency !== false;
  if (asaHasSpendWithoutInstalls(totalCost, installs)) {
    return '—（有花费无安装）';
  }
  return withCurrency ? `$${toFixed2(value || 0)}` : `${toFixed2(value || 0)}`;
}

function formatAsaCppDisplay(value, totalCost, purchaseCount, roasDataStatus) {
  const status = normalizeRoasDataStatus(roasDataStatus);
  if (status === 'pending') {
    return '待补齐（源数据缺失）';
  }
  if (status === 'partial') {
    if (Number(purchaseCount || 0) <= 0) {
      return Number(totalCost || 0) > 0 ? '—（覆盖率达阈值，但成熟窗口无购买）' : '-';
    }
    return `$${toFixed2(value || 0)}（按已覆盖成本计算）`;
  }
  if (status === 'partial_low') {
    if (Number(purchaseCount || 0) <= 0) {
      return Number(totalCost || 0) > 0 ? '—（覆盖率偏低，成熟窗口无购买）' : '-';
    }
    return `$${toFixed2(value || 0)}（覆盖率偏低，仅供参考）`;
  }
  if (status === 'unavailable') {
    return Number(totalCost || 0) > 0 ? '暂无成熟数据' : '-';
  }
  if (Number(purchaseCount || 0) <= 0) {
    return Number(totalCost || 0) > 0 ? '—（成熟窗口无购买）' : '-';
  }
  return `$${toFixed2(value || 0)}`;
}

function formatAsaD7RoasDisplay(value, totalCost, revenueD7, roasDataStatus, source = {}) {
  const status = normalizeRoasDataStatus(roasDataStatus);
  const sourceText = buildRoasSourceMetaText(
    source.roas_primary_source ?? source.roasPrimarySource,
    source.roas_warning_code ?? source.roasWarningCode
  );
  if (status === 'pending') {
    return `待补齐（源数据缺失）${sourceText ? `｜${sourceText}` : ''}`;
  }
  if (status === 'partial') {
    if (Number(totalCost || 0) <= 0) {
      return '-';
    }
    return `${formatRoasPercent(value)}（按已覆盖成本计算）${sourceText ? `｜${sourceText}` : ''}`;
  }
  if (status === 'partial_low') {
    if (Number(totalCost || 0) <= 0) {
      return '-';
    }
    return `${formatRoasPercent(value)}（覆盖率偏低，仅供参考）${sourceText ? `｜${sourceText}` : ''}`;
  }
  if (status === 'unavailable') {
    return Number(totalCost || 0) > 0 ? `暂无成熟数据${sourceText ? `｜${sourceText}` : ''}` : '-';
  }
  if (Number(totalCost || 0) <= 0) {
    return '-';
  }
  return `${formatRoasPercent(value)}${sourceText ? `｜${sourceText}` : ''}`;
}

function formatAsaD7RoasDisplayWithReason(value, totalCost, revenueD7, roasDataStatus, source = {}) {
  const status = normalizeRoasDataStatus(roasDataStatus);
  const sourceText = buildRoasSourceMetaText(
    source.roas_primary_source ?? source.roasPrimarySource,
    source.roas_warning_code ?? source.roasWarningCode
  );
  if (status === 'pending') {
    return `待补齐（源数据缺失）${sourceText ? `｜${sourceText}` : ''}`;
  }
  if (status === 'partial') {
    if (Number(totalCost || 0) <= 0) {
      return '-';
    }
    const base = `${formatRoasPercent(value)}（按已覆盖成本计算）${sourceText ? `｜${sourceText}` : ''}`;
    return asaHasCostWithoutD7Revenue(totalCost, revenueD7)
      ? `${base}（成熟窗口未观察到D7收入）`
      : base;
  }
  if (status === 'partial_low') {
    if (Number(totalCost || 0) <= 0) {
      return '-';
    }
    const base = `${formatRoasPercent(value)}（覆盖率偏低，仅供参考）${sourceText ? `｜${sourceText}` : ''}`;
    return asaHasCostWithoutD7Revenue(totalCost, revenueD7)
      ? `${base}（成熟窗口未观察到D7收入）`
      : base;
  }
  if (status === 'unavailable') {
    return Number(totalCost || 0) > 0 ? `暂无成熟数据${sourceText ? `｜${sourceText}` : ''}` : '-';
  }
  if (Number(totalCost || 0) <= 0) {
    return '-';
  }
  const base = `${formatRoasPercent(value)}${sourceText ? `｜${sourceText}` : ''}`;
  return asaHasCostWithoutD7Revenue(totalCost, revenueD7) ? `${base}（成熟窗口未观察到D7收入）` : base;
}

function resolveAsaTrendRoasStatus(source = {}) {
  return buildAsaTrendMetricDisplaySource(source).roasStatus;
}

function resolveAsaTrendCppStatus(source = {}) {
  return buildAsaTrendMetricDisplaySource(source).cppStatus;
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
        <td class="table-cell-wrap">${escapeHtml(row.adset || '-')}</td>
        <td>${toFixed2(row.installs_7d || row.last_installs || 0)}</td>
        <td>$${toFixed2(row.total_cost_7d || 0)}</td>
        <td>${toFixed2(row.purchase_count_7d || 0)}</td>
        <td title="${escapeHtml(asaHasSpendWithoutInstalls(row.total_cost_7d, row.installs_7d || row.last_installs || 0) ? '当前有花费但没有安装，eCPI 不可计算' : '')}">${escapeHtml(formatAsaEcpiDisplay(row.current_ecpi || 0, row.total_cost_7d || 0, row.installs_7d || row.last_installs || 0))}</td>
        <td title="${escapeHtml(buildAsaCppMetricTitle(row))}">${buildAsaCppMetricStackHtml(row)}</td>
        <td title="${escapeHtml(buildAsaD7RoasMetricTitle(row))}">${buildAsaD7RoasMetricStackHtml(row)}</td>
        <td><span class="badge badge-stage-${escapeHtml(row.current_stage)}">${asaStageLabel(row.current_stage)}</span></td>
        <td>${row.recommendation_action ? `<span class="badge ${asaRecommendationBadgeClass(row.recommendation_action)}">${escapeHtml(actionLabel(row.recommendation_action))}</span>` : '-'}</td>
        <td>${escapeHtml(asaRecommendationStatusLabel(row.recommendation_status))}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-ghost btn-compact" type="button" data-asa-keyword-view-id="${row.id}">查看说明</button>
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
  state.asaKeywordsLoadedAt = new Date().toISOString();
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
  const chartRows = trendRows.map((item) => {
    const trendMetric = buildAsaTrendMetricDisplaySource(item);
    return {
      label: item.date,
      value: Number(item.installs || 0),
      tooltipLines: [
        `日期：${item.date}`,
        `安装量：${toFixed2(item.installs)}`,
        `成本：$${toFixed2(item.total_cost)}`,
        `购买次数：${toFixed2(item.purchase_count)}`,
        `eCPI：${formatAsaEcpiDisplayWithReason(item.ecpi, item.total_cost, item.installs)}`,
        `官方 eCPI：$${toFixed2(item.average_ecpi || 0)}`,
        `CPP：${formatAsaCppDisplay(item.cpp, item.total_cost, item.purchase_count, trendMetric.cppStatus)}`,
        `D7 ROAS：${formatAsaD7RoasDisplayWithReason(trendMetric.d7Roas, item.total_cost, item.revenue_d7, trendMetric.roasStatus, trendMetric)}`
      ]
    };
  });
  drawLineChart(el.asaKeywordTrendCanvas, chartRows);
  const llmSummary = safeJsonParse(row.llm_summary, {});
  const actionItems = Array.isArray(llmSummary.action_items) ? llmSummary.action_items : [];
  el.asaKeywordDrawerMeta.textContent =
    `产品视图 ${productViewName(row.app_key, row.platform || 'unknown')} · 应用标识 ${row.app_key} · 平台 ${platformLabel(row.platform || 'unknown')} · 关键词 ${row.keyword} · 广告系列 ${row.campaign} · 广告组 ${row.adset || '-'} · 当前阶段 ${asaStageLabel(row.current_stage)} · 建议指标 ${asaPrimaryMetricLabel(row.primary_metric)}`;
  const last = trendRows.at(-1);
  const lastTrendMetric = buildAsaTrendMetricDisplaySource(last || {});
  el.asaKeywordTrendLegend.textContent =
    `数据点 ${trendRows.length} · 最新安装量 ${toFixed2(last?.installs)} · 最新 eCPI ${formatAsaEcpiDisplayWithReason(last?.ecpi, last?.total_cost, last?.installs)} · 参考 eCPI $${toFixed2(last?.average_ecpi || 0)} · 最新 D7 ROAS ${formatAsaD7RoasDisplayWithReason(lastTrendMetric.d7Roas, last?.total_cost, last?.revenue_d7, lastTrendMetric.roasStatus, lastTrendMetric)}`;
  el.asaKeywordActionItems.innerHTML = actionItems.map((item) => `<li>${escapeHtml(String(item))}</li>`).join('');
  el.asaKeywordTrendRaw.textContent = JSON.stringify(
    {
      recommendation: {
        action: row.recommendation_action,
        status: row.recommendation_status,
        summary: llmSummary.summary_cn || '',
        explanation_points: llmSummary.explanation_points || [],
        action_items: actionItems,
        scenario_tags: llmSummary.scenario_tags || []
      },
      note: 'ASA 关键词成本来自 AppsFlyer 的关键词级成本接口。eCPI 显示为“—”表示有花费但没有安装；D7 ROAS 显示“待补齐/暂无成熟数据”表示 Cohort 源数据尚未完整。',
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
    showToast(`ASA 关键词重算完成：阶段记录 ${result.state_rows || 0} / 建议 ${result.recommendation_rows || 0}`);
    state.asaKeywordPage = 1;
    await loadAsaKeywords(undefined, 1);
  } finally {
    el.asaKeywordRecomputeBtn.disabled = false;
    el.asaKeywordRecomputeBtn.textContent = originalText;
  }
}

function asaBriefSummaryItems(report) {
  const summary = report.summary || {};
  const summaryWindow = report.summary_window || null;
  const cppLabel = summaryWindow ? '每次购买成本（CPP，成熟窗口）' : '每次购买成本（CPP）';
  const roasLabel = summaryWindow ? '7 日回收率（D7 ROAS，成熟窗口）' : '7 日回收率（D7 ROAS）';
  return [
    { label: '当前阶段', value: asaStageLabel(report.current_stage) },
    { label: '关键词数', value: String(summary.keyword_count || 0) },
    { label: '安装量', value: toFixed2(summary.installs || 0) },
    { label: '成本', value: `$${toFixed2(summary.total_cost || 0)}` },
    { label: '每次安装成本（eCPI）', value: formatAsaEcpiDisplay(summary.ecpi || 0, summary.total_cost || 0, summary.installs || 0) },
    { label: cppLabel, value: formatAsaCppDisplay(summary.cpp || 0, summary.total_cost || 0, summary.purchase_count || 0, summary.roas_data_status) },
    { label: roasLabel, value: formatAsaD7RoasDisplay(summary.d7_roas || 0, summary.total_cost || 0, summary.revenue_d7 || 0, summary.roas_data_status, summary) }
  ];
}

function renderAsaBriefModal(payload, mode) {
  const report = payload?.report || payload || {};
  const notify = payload?.notify || null;
  const skipped = payload?.skipped === true;
  const actionRows = Array.isArray(report.action_rows) ? report.action_rows : [];
  const summaryWindow = report.summary_window || null;
  el.asaBriefModalTitle.textContent = mode === 'send' ? 'ASA 简报发送结果' : 'ASA 简报预览';
  const sendStatus = notify?.ok ? (skipped ? '今日已发送，已跳过重复发送' : '已发送到飞书') : '发送失败';
  el.asaBriefMeta.textContent =
    `报告日期 ${report.report_date || '-'} · 当前阶段 ${asaStageLabel(report.current_stage)} · 关键词数 ${report.summary?.keyword_count || 0}` +
    (summaryWindow ? ` · D7/CPP 窗口 ${summaryWindow.from}~${summaryWindow.to}` : '') +
    (notify || skipped ? ` · ${sendStatus}` : '');
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
      ? '当前按稳定期标准输出建议，优先观察 7 日回收率和每次购买成本是否同步达标。'
      : '当前按上升期标准输出建议，优先观察每次安装成本和安装增长效率。');
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
              <p>广告系列：${escapeHtml(row.campaign)}</p>
              <p>广告组：${escapeHtml(row.adset || '-')}</p>
              <p>${escapeHtml(
                row.primary_metric === 'd7_roas_cpp'
                  ? `D7 ROAS ${formatAsaD7RoasDisplayWithReason(row.current_d7_roas, row.total_cost_7d, row.revenue_d7_7d, row.roas_data_status, row)} / 目标 ${formatRoasPercent(row.target_d7_roas)} ｜ CPP ${formatAsaCppDisplay(row.current_cpp, row.total_cost_7d, row.purchase_count_7d, row.roas_data_status)} / 目标 ${row.target_cpp > 0 ? `$${toFixed2(row.target_cpp)}` : '-'}`
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
  state.asaBriefPreviewPayload = body.data || null;
  state.asaBriefPreviewLoadedAt = new Date().toISOString();
  renderAsaBriefModal(body.data, 'preview');
  el.asaBriefStatus.textContent = `已生成 ${reportDate} 的 ASA 简报预览，建议动作会随简报一起发送。`;
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
  state.asaBriefPreviewPayload = body.data || null;
  state.asaBriefPreviewLoadedAt = new Date().toISOString();
  renderAsaBriefModal(body.data, 'send');
  el.asaBriefStatus.textContent = `ASA 简报已发送到飞书：${reportDate}，建议动作已随简报一并发送。`;
  showToast('ASA 简报已发送到飞书');
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

  const now = new Date();
  const params = new URLSearchParams({
    appKey,
    metric,
    source
  });
  if (platform) {
    params.set('platform', platform);
  }
  if (source === 'pull') {
    const to = new Date(now);
    const from = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    params.set('from', toSqlDate(from));
    params.set('to', toSqlDate(to));
    params.set('granularity', 'day');
  } else {
    const to = new Date(now);
    const from = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    params.set('from', toSqlDateTime(from));
    params.set('to', toSqlDateTime(to));
    params.set('granularity', 'hour');
    if (eventName) params.set('eventName', eventName);
  }

  const body = await api(`/api/metrics?${params.toString()}`);
  const rows = body.data || [];
  state.metricsRows = Array.isArray(rows) ? rows : [];
  state.metricsQuery = {
    appKey,
    platform,
    from: params.get('from') || '',
    to: params.get('to') || '',
    source,
    metric,
    eventName
  };
  state.metricsLoadedAt = new Date().toISOString();
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
      '当前没有广告日报数据。请联系管理员检查数据连接或抓取配置。';
    return;
  }
  el.metricsLegend.textContent = `数据点 ${rows.length} · 最新值 ${lastValue} · 来源 ${source === 'pull' ? '广告日报（日）' : '实时回传（小时）'}`;
}

function renderOperationLogsTable() {
  const rows = state.operationLogs || [];
  if (rows.length === 0) {
    el.operationLogsTableBody.innerHTML =
      '<tr><td class="table-empty" colspan="5">当前筛选条件下暂无操作记录</td></tr>';
    return;
  }

  el.operationLogsTableBody.innerHTML = rows
    .map((row) => {
      const detail = safeJsonParse(row.detail_json, row.detail_json || {});
      const pretty = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
      const sourceText = operationSourceLabel(row.source);
      const actionText = operationActionLabel(row.action);
      const summaryText = row.summary || '无摘要';
      return `
        <tr>
          <td class="table-cell-mono">${escapeHtml(fmtTime(row.created_at))}</td>
          <td class="table-cell-wrap">${escapeHtml(`${sourceText} · ${actionText}`)}</td>
          <td><span class="badge badge-${escapeHtml(row.status)}">${escapeHtml(operationStatusLabel(row.status))}</span></td>
          <td class="table-cell-wrap">${escapeHtml(summaryText)}</td>
          <td>
            <details>
              <summary>查看技术详情</summary>
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
  await safeRefresh('Guru Ads Agent 模型', () => loadAIChatModels());
  const now = new Date();
  updateOverviewCards(now);

  const firstApp = state.apps[0]?.app_key || '';
  await safeRefresh('规则设置', () => loadRules(firstApp));

  el.alertsAppSelect.value = firstApp;
  await safeRefresh('告警列表', () => loadAlerts());

  if (firstApp) {
    el.metricsAppSelect.value = firstApp;
    await safeRefresh('指标趋势', () => loadMetrics());
  }

  state.pullPage = 1;
  await safeRefresh('广告日报明细', () => loadPullRecords(undefined, 1));

  state.keywordPage = 1;
  await safeRefresh('关键词生命周期', () => loadKeywordLifecycle(undefined, 1));

  await safeRefresh('应用级策略', () => loadRecommendationPolicies());
  state.budgetPage = 1;
  await safeRefresh('预算建议', () => loadBudgetRecommendations(undefined, 1));
  await safeRefresh('预算建议进度', () => loadBudgetRecomputeStatus());
  await safeRefresh('ASA 阶段配置', () => loadAsaStageConfigs());
  state.asaKeywordPage = 1;
  await safeRefresh('ASA 关键词', () => loadAsaKeywords(undefined, 1));
  await safeRefresh('操作记录', () => loadOperationLogs());
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
  renderRecommendationPolicyEditor();
  if (el.runtimePullTimeInput) {
    el.runtimePullTimeInput.value = '09:00';
  }
  if (el.runtimePushTimeInput) {
    el.runtimePushTimeInput.value = '10:00';
  }
  renderRuntimeSchedulePreview();
  syncAppFeishuSection();
  setRulesSectionExpanded(false);
  applyUniformFieldLabels();
  setActiveNav('section-overview');
  primeAIChatBuilderDefaults();
  renderAIChatMessages();
  renderAIChatAttachmentStrip();
  syncAIChatModelUi();
  syncAIChatInputHeight();
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
el.toggleRulesSectionBtn?.addEventListener('click', () => {
  setRulesSectionExpanded(!state.rulesSectionExpanded);
});
el.buildDslJsonBtn.addEventListener('click', () => {
  const json = buildRuleFromDslForm();
  ruleField('rule_json').value = JSON.stringify(json, null, 2);
  showToast('已根据表单生成规则配置');
});
el.loadDslFromJsonBtn.addEventListener('click', () => {
  try {
    const parsed = JSON.parse(ruleField('rule_json').value || '{}');
    loadDslFormFromRule(parsed);
    showToast('已根据规则配置回填表单');
  } catch (err) {
    showToast(err.message || '规则配置格式无效', true);
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
  loadPullRecords(e, 1).catch((err) => showToast(err.message || '广告日报明细加载失败，请联系管理员检查数据连接', true))
);
el.pullRecordsTableBody.addEventListener('click', (e) =>
  handlePullRecordsTableClick(e).catch((err) => showToast(err.message || '广告日报详情加载失败', true))
);
el.pullPrevPageBtn.addEventListener('click', () =>
  changePullPage(-1).catch((err) => showToast(err.message || '翻页失败', true))
);
el.pullNextPageBtn.addEventListener('click', () =>
  changePullPage(1).catch((err) => showToast(err.message || '翻页失败', true))
);
el.triggerPullBtn.addEventListener('click', () =>
  triggerPullOnce().catch((err) => showToast(err.message || '手动拉取失败', true))
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
el.budgetExportFeedbackBtn.addEventListener('click', () =>
  exportBudgetFeedbackData().catch((err) => showToast(err.message || '预算反馈导出失败', true))
);
el.budgetDownloadSkillsBtn.addEventListener('click', () =>
  downloadLatestBudgetSkills().catch((err) => showToast(err.message || 'skills 下载失败', true))
);
el.budgetRecomputeBtn.addEventListener('click', () =>
  triggerBudgetRecompute().catch((err) => showToast(err.message || '预算建议生成失败', true))
);
el.closeBudgetDetailModalBtn.addEventListener('click', () => setBudgetDetailModalOpen(false));
el.budgetDetailModalBackdrop.addEventListener('click', () => setBudgetDetailModalOpen(false));

el.recommendationPolicyForm?.addEventListener('submit', (e) =>
  saveRecommendationPolicy(e).catch((err) => showToast(err.message || '应用级策略保存失败', true))
);
el.recommendationPolicyPlatformSelect?.addEventListener('change', () =>
  handleRecommendationPolicySelectionChange({ platform: el.recommendationPolicyPlatformSelect.value })
);
el.recommendationPolicyAppSelect?.addEventListener('change', () =>
  handleRecommendationPolicySelectionChange({ appKey: el.recommendationPolicyAppSelect.value })
);
el.recommendationPolicyEngineSelect?.addEventListener('change', () =>
  handleRecommendationPolicySelectionChange({ engine: el.recommendationPolicyEngineSelect.value })
);
el.recommendationPolicyMetricFamilySelect?.addEventListener('change', () =>
  applyRecommendationPolicyMetricFamilyChange(String(el.recommendationPolicyMetricFamilySelect.value || 'ecpi'))
);
el.recommendationPolicyDecisionModeSelect?.addEventListener('change', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyTrafficScopeSelect?.addEventListener('change', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyExcludeRecentInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyDecisionWindowInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyEcpiMaxInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyRoasMinInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyRoasGoodInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyCppMaxInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyCppPauseInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyRelativeUnderperformInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyRelativePeerCountInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyRelativeMinFailedInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyDailyCapInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyLowSpendInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyHighSpendInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyTrendLookbackInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyUptrendRatioInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyDefaultIncreaseRatioInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyDefaultDecreaseRatioInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyHighSpendIncreaseRatioInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyPromptInput?.addEventListener('input', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyEnabledSelect?.addEventListener('change', handleRecommendationPolicyScalarInputChange);
el.recommendationPolicyForm
  ?.querySelectorAll('input[name="recommendationPolicyRelativeMetric"]')
  .forEach((node) => node.addEventListener('change', handleRecommendationPolicyScalarInputChange));
el.recommendationPolicyUseRecommendedBtn?.addEventListener('click', () => applyRecommendationPolicyTemplate('recommended'));
el.recommendationPolicyUseBlankBtn?.addEventListener('click', () => applyRecommendationPolicyTemplate('blank'));
el.recommendationPolicyPrevBtn?.addEventListener('click', () => changeRecommendationPolicyStep(getRecommendationPolicyEditor().step - 1));
el.recommendationPolicyNextBtn?.addEventListener('click', () => changeRecommendationPolicyStep(getRecommendationPolicyEditor().step + 1));
el.recommendationPolicySteps?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const step = Number(target.dataset.policyStepTarget || '0');
  if (step > 0) {
    changeRecommendationPolicyStep(step);
  }
});
el.recommendationPolicyAddMediaSourceBtn?.addEventListener('click', () =>
  addRecommendationPolicyChip('mediaSources', el.recommendationPolicyMediaSourceDraftInput?.value)
);
el.recommendationPolicyMediaSourceDraftInput?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') {
    return;
  }
  event.preventDefault();
  addRecommendationPolicyChip('mediaSources', el.recommendationPolicyMediaSourceDraftInput.value);
});
el.recommendationPolicyAddContextWindowBtn?.addEventListener('click', () =>
  addRecommendationPolicyChip('contextWindowDays', el.recommendationPolicyContextWindowDraftInput?.value)
);
el.recommendationPolicyContextWindowDraftInput?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') {
    return;
  }
  event.preventDefault();
  addRecommendationPolicyChip('contextWindowDays', el.recommendationPolicyContextWindowDraftInput.value);
});
el.recommendationPolicyAddCountryTargetBtn?.addEventListener('click', () => addRecommendationPolicyTargetRow('country'));
el.recommendationPolicyAddMediaTargetBtn?.addEventListener('click', () => addRecommendationPolicyTargetRow('media'));
el.recommendationPolicyCountryTargetsList?.addEventListener('input', handleRecommendationPolicyTargetInput);
el.recommendationPolicyMediaTargetsList?.addEventListener('input', handleRecommendationPolicyTargetInput);
el.recommendationPolicyCountryTargetsList?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const kind = String(target.dataset.policyTargetKind || 'country');
  const rowId = String(target.dataset.policyTargetRemove || target.dataset.policyTargetCopy || '').trim();
  if (!rowId) {
    return;
  }
  if (target.dataset.policyTargetRemove) {
    removeRecommendationPolicyTargetRow(kind, rowId);
    return;
  }
  if (target.dataset.policyTargetCopy) {
    copyRecommendationPolicyTargetRow(kind, rowId);
  }
});
el.recommendationPolicyMediaTargetsList?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const kind = String(target.dataset.policyTargetKind || 'media');
  const rowId = String(target.dataset.policyTargetRemove || target.dataset.policyTargetCopy || '').trim();
  if (!rowId) {
    return;
  }
  if (target.dataset.policyTargetRemove) {
    removeRecommendationPolicyTargetRow(kind, rowId);
    return;
  }
  if (target.dataset.policyTargetCopy) {
    copyRecommendationPolicyTargetRow(kind, rowId);
  }
});
el.recommendationPolicyMediaSourcesChips?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  removeRecommendationPolicyChip(String(target.dataset.policyChipKind || ''), String(target.dataset.policyChipValue || ''));
});
el.recommendationPolicyContextWindowChips?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  removeRecommendationPolicyChip(String(target.dataset.policyChipKind || ''), String(target.dataset.policyChipValue || ''));
});
el.recommendationPoliciesTableBody?.addEventListener('click', (e) =>
  handleRecommendationPoliciesTableClick(e).catch((err) => showToast(err.message || '策略加载失败', true))
);

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
  loadOperationLogs(e).catch((err) => showToast(err.message || '操作记录加载失败', true))
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
    return;
  }
  if (target.dataset.role === 'sync-feedback') {
    syncBitableFeedbackCard(sourceType).catch((err) => showToast(err.message || '执行反馈回读失败', true));
  }
});
el.bitableExportCards?.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  const card = target.closest('.bitable-export-card');
  if (target.dataset.role === 'selected-field') {
    refreshBitableFieldCount(card);
  }
});
el.dailyBriefModalCloseBtn.addEventListener('click', () => setDailyBriefModalOpen(false));
el.dailyBriefModalBackdrop.addEventListener('click', () => setDailyBriefModalOpen(false));
el.aiDockToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (aiDockSuppressToggleClick) {
    event.preventDefault();
    return;
  }
  toggleAIDock();
});
el.aiDockToggle?.addEventListener('pointerdown', (event) => handleAIDockPointerDown(event));
el.aiDockToggle?.addEventListener('pointermove', (event) => handleAIDockPointerMove(event));
el.aiDockToggle?.addEventListener('pointerup', (event) => handleAIDockPointerUp(event));
el.aiDockToggle?.addEventListener('pointercancel', (event) => handleAIDockPointerCancel(event));
el.aiDockBackdrop?.addEventListener('click', () => setAIDockOpen(false));
el.aiChatCloseBtn?.addEventListener('click', () => setAIDockOpen(false));
el.aiChatClearBtn?.addEventListener('click', () => {
  clearAIChatConversation();
  showToast('AI 会话已清空');
});
el.aiChatModelSelect?.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  setAIChatModelSelection(target.value, { persist: true });
  const selectedModel = getAIChatModelOption(target.value);
  if (selectedModel && selectedModel.supportsImages === false && (state.aiChat.selectedImages || []).length > 0) {
    showToast(`当前 ${selectedModel.label} 仅支持文本，发送时会自动切回支持图片的模型。`);
  }
});
el.aiChatAddImageBtn?.addEventListener('click', () => {
  if (el.aiChatFileInput instanceof HTMLInputElement) {
    el.aiChatFileInput.click();
  }
});
el.aiChatImageUploaderInline?.addEventListener('click', () => {
  if (el.aiChatFileInput instanceof HTMLInputElement) {
    el.aiChatFileInput.click();
  }
});
el.aiChatAddContextBtn?.addEventListener('click', () => {
  setAIChatContextMenuOpen(!state.aiChat.contextMenuOpen);
});
el.aiChatInput?.addEventListener('input', () => syncAIChatInputHeight());
el.aiChatInput?.addEventListener('keydown', (event) => handleAIChatInputKeydown(event));
el.aiChatFileInput?.addEventListener('change', (event) => {
  try {
    handleAIChatImageSelection(event);
  } catch (error) {
    showToast(error.message || '图片上传失败', true);
  }
});
el.aiChatAttachmentStrip?.addEventListener('click', (event) => handleAIChatAttachmentStripClick(event));
el.aiChatRecommendedPacks?.addEventListener('click', (event) => handleAIChatPackCardClick(event));
el.aiChatCorePacks?.addEventListener('click', (event) => handleAIChatPackCardClick(event));
el.aiChatContextMenu?.addEventListener('toggle', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLDetailsElement)) {
    return;
  }
  if (target.open && target.classList.contains('ai-chat-subfold')) {
    const wrapper = target.parentElement;
    wrapper?.querySelectorAll('.ai-chat-subfold').forEach((item) => {
      if (item !== target) {
        item.open = false;
      }
    });
    syncAIChatAccordionState();
    return;
  }
  if (target.open && target.classList.contains('ai-chat-fold')) {
    el.aiChatContextMenu?.querySelectorAll('.ai-chat-fold').forEach((item) => {
      if (item !== target) {
        item.open = false;
      }
    });
  }
  syncAIChatAccordionState();
});
el.aiChatPackTypeSelect?.addEventListener('change', () => syncAIChatContextBuilderVisibility());
el.aiChatPackSourceSelect?.addEventListener('change', () => syncAIChatContextBuilderVisibility());
el.aiChatPackMetricSelect?.addEventListener('change', () => syncAIChatContextBuilderVisibility());
el.aiChatPackTemplateSelect?.addEventListener('change', () => syncAIChatPackBuilderPreview());
el.aiChatPackAppSelect?.addEventListener('change', () => syncAIChatPackBuilderPreview());
el.aiChatPackPlatformSelect?.addEventListener('change', () => syncAIChatPackBuilderPreview());
el.aiChatPackFromInput?.addEventListener('input', () => syncAIChatPackBuilderPreview());
el.aiChatPackToInput?.addEventListener('input', () => syncAIChatPackBuilderPreview());
el.aiChatPackEventNameInput?.addEventListener('input', () => syncAIChatPackBuilderPreview());
el.aiChatPackStageSelect?.addEventListener('change', () => syncAIChatPackBuilderPreview());
el.aiChatAttachCustomPackBtn?.addEventListener('click', () => {
  try {
    addAIChatContextPack(buildCustomAIChatPackSpec());
  } catch (error) {
    showToast(error.message || '附加数据包失败', true);
  }
});
el.aiChatForm?.addEventListener('submit', (event) => sendAIChat(event).catch((err) => showToast(err.message || '发送失败', true)));
el.aiDockPanel?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  if (target.closest('[data-role="gemini-link"]')) {
    showToast('正在打开 Gemini 官网');
    setAIDockOpen(false);
  }
});

initializeHelpPopovers();

helpPopoverGroups.forEach((group) => {
  const popover = getHelpPopover(group);
  const trigger = getHelpTrigger(group);
  syncHelpTriggerExpandedState(group, false);
  group.addEventListener('mouseenter', () => showHelpPopover(group));
  group.addEventListener('mouseleave', () => scheduleHideHelpPopover(group));
  group.addEventListener('focusin', () => showHelpPopover(group));
  group.addEventListener('focusout', (event) => handleHelpFocusOut(group, event));
  if (trigger) {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleHelpPopover(group);
    });
  }
  if (popover) {
    popover.addEventListener('click', (event) => event.stopPropagation());
    popover.addEventListener('mouseenter', () => showHelpPopover(group));
    popover.addEventListener('mouseleave', () => scheduleHideHelpPopover(group));
  }
});

document.addEventListener('click', () => hideAllHelpPopovers());
document.addEventListener('click', (event) => {
  if (!(el.aiDock instanceof HTMLElement)) {
    return;
  }
  if (state.aiChat.contextMenuOpen) {
    const target = event.target;
    if (
      target instanceof Node &&
      (el.aiChatContextMenu?.contains(target) || el.aiChatAddContextBtn?.contains(target))
    ) {
      return;
    }
    setAIChatContextMenuOpen(false);
  }
  const target = event.target;
  if (target instanceof Node && el.aiDock.contains(target)) {
    return;
  }
  setAIDockOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (state.aiChat.aiDockOpen && event.key === 'Tab') {
    handleAIDockFocusTrap(event);
    return;
  }
  if (event.key === 'Escape') {
    hideAllHelpPopovers();
    if (state.aiChat.contextMenuOpen) {
      setAIChatContextMenuOpen(false);
      return;
    }
    setAIDockOpen(false);
  }
});

window.addEventListener('resize', () => {
  refreshHelpPopoverPositions();
  refreshAIDockFabPosition();
});
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

restoreAIDockFabPosition();
bootstrap();

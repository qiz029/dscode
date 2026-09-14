// DSCODE user-interface strings. English is the default; /language switches
// between the supported locales and the choice is stored per machine in
// ~/.dsh/dsh-code/language.json (DSCODE_LANGUAGE overrides it for one process).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'es', name: 'Español' },
];

export const ALIASES = {
  en: ['en', 'english', 'eng', '英文', '英语', '英語'],
  'zh-CN': ['zh-cn', 'zh', 'zh-hans', 'zhhans', 'cn', 'chinese', 'simplified', '中文', '简体', '简体中文', '简中', '中文简体'],
  'zh-TW': ['zh-tw', 'zh-hant', 'zhhant', 'tw', 'hk', 'zh-hk', 'traditional', '繁体', '繁體', '繁體中文', '繁体中文', '繁中'],
  ja: ['ja', 'jp', 'japanese', '日本語', '日语', '日語'],
  ko: ['ko', 'kr', 'korean', '한국어', '韩语', '韓語', '韓文'],
  es: ['es', 'spanish', 'español', 'espanol', '西班牙语', '西班牙語'],
};

export const MESSAGES = {
  en: {
    'activity.replying': 'Replying', 'activity.thinking': 'Thinking', 'activity.running': 'Running',
    'activity.turn': 'this turn', 'activity.interrupt': 'Esc to interrupt',
    'agents.running': 'running', 'agents.idle': 'idle', 'agents.done': 'done', 'agents.total': 'total',
    'welcome.model': 'model', 'welcome.effort': 'effort', 'welcome.project': 'project',
    'verbose.on': 'verbose on: thinking and tool calls are shown in the chat', 'verbose.off': 'verbose off',
    'mouse.on': 'mouse on: the wheel scrolls the chat · hold Shift while dragging to select text (Option in iTerm2, Fn in Terminal)',
    'mouse.off': 'mouse off: select and copy freely · PageUp/PageDown scroll the chat · /mouse turns wheel scrolling on',
    'language.current': 'Language: {name} · /language en | zh-CN | zh-TW | ja | ko | es',
    'language.set': 'language → {name}', 'language.title': '/language — interface language', 'language.currentMark': 'current', 'language.unknown': 'Unknown language "{value}". Choose en, zh-CN, zh-TW, ja, ko or es.',
    'language.saveFailed': 'language save failed: {error}',
    'doctor.logs.new': 'Only warnings/errors since this TUI version started are recorded.',
    'footer.current': 'current', 'footer.average': 'average', 'footer.context': 'context', 'footer.cache': 'cache', 'composer.placeholder': 'type a message',
    'doctor.nearTimeout': 'Assessment: {count} Bash calls ended at about 300 seconds, which matches the tool timeout; traces alone cannot prove the root cause. Next, check those calls\' shell completion markers and terminal errors.',
    'doctor.logs.none': 'No log file yet; earlier console logs were not persisted and cannot be recovered.',
    'doctor.evidence': 'Diagnostic evidence: {traces} recent sessions, {logs} warnings/errors.',
    'doctor.noFindings': 'No clear timeouts, unfinished tool calls or error events in recent traces.',
    'doctor.noRoute': 'No model route is available, so the model analysis could not run.',
    'doctor.scope': 'Evidence scope: {traces} recent sessions, {logs} warnings/errors; conversation text, tool arguments and tool output were not read.',
    'doctor.failed': 'Model analysis did not finish: {error}.',
  },
  'zh-CN': {
    'activity.replying': '正在回复', 'activity.thinking': '正在思考', 'activity.running': '正在执行',
    'activity.turn': '本轮', 'activity.interrupt': 'Esc 中断',
    'agents.running': '运行中', 'agents.idle': '空闲', 'agents.done': '已完成', 'agents.total': '总计',
    'welcome.model': '模型', 'welcome.effort': '推理', 'welcome.project': '项目',
    'verbose.on': '详细模式已开启：对话中显示思考与工具调用', 'verbose.off': '详细模式已关闭',
    'mouse.on': '鼠标捕获已开启：滚轮滚动对话 · 拖选文本时按住 Shift（iTerm2 按住 Option、Terminal 按住 Fn）',
    'mouse.off': '鼠标捕获已关闭：可自由选择复制 · PageUp/PageDown 滚动对话 · /mouse 重新开启',
    'language.current': '语言：{name} · /language en | zh-CN | zh-TW | ja | ko | es',
    'language.set': '语言 → {name}', 'language.title': '/language — 界面语言', 'language.currentMark': '当前', 'language.unknown': '未知语言 "{value}"。可选 en、zh-CN、zh-TW、ja、ko、es。',
    'language.saveFailed': '语言设置保存失败：{error}',
    'doctor.logs.new': '仅记录新版 TUI 启动后的 warning/error。',
    'footer.current': '当前', 'footer.average': '平均', 'footer.context': '上下文', 'footer.cache': '缓存', 'composer.placeholder': '输入消息',
    'doctor.nearTimeout': '判断：{count} 次 Bash 调用在约 300 秒结束，符合工具超时特征；trace 不能单独证明触发超时的根因。下一步检查这些调用的 shell 完成标记和终端错误。',
    'doctor.logs.none': '日志文件尚未建立；旧版控制台日志未持久化，无法回溯。',
    'doctor.evidence': '诊断证据：{traces} 个近期会话、{logs} 条 warning/error。',
    'doctor.noFindings': '近期 trace 中未发现明确的超时、未完成工具调用或错误事件。',
    'doctor.noRoute': '没有可用的模型路由，无法运行模型分析。',
    'doctor.scope': '证据范围：{traces} 个近期会话、{logs} 条 warning/error；未读取对话正文、工具参数或工具输出。',
    'doctor.failed': '模型分析未完成：{error}。',
  },
  'zh-TW': {
    'activity.replying': '正在回覆', 'activity.thinking': '正在思考', 'activity.running': '正在執行',
    'activity.turn': '本輪', 'activity.interrupt': 'Esc 中斷',
    'agents.running': '執行中', 'agents.idle': '閒置', 'agents.done': '已完成', 'agents.total': '總計',
    'welcome.model': '模型', 'welcome.effort': '推理', 'welcome.project': '專案',
    'verbose.on': '詳細模式已開啟：對話中顯示思考與工具呼叫', 'verbose.off': '詳細模式已關閉',
    'mouse.on': '滑鼠擷取已開啟：滾輪捲動對話 · 拖選文字時按住 Shift（iTerm2 按住 Option、Terminal 按住 Fn）',
    'mouse.off': '滑鼠擷取已關閉：可自由選取複製 · PageUp/PageDown 捲動對話 · /mouse 重新開啟',
    'language.current': '語言：{name} · /language en | zh-CN | zh-TW | ja | ko | es',
    'language.set': '語言 → {name}', 'language.title': '/language — 介面語言', 'language.currentMark': '目前', 'language.unknown': '未知語言 "{value}"。可選 en、zh-CN、zh-TW、ja、ko、es。',
    'language.saveFailed': '語言設定儲存失敗：{error}',
    'doctor.logs.new': '僅記錄新版 TUI 啟動後的 warning/error。',
    'footer.current': '目前', 'footer.average': '平均', 'footer.context': '上下文', 'footer.cache': '快取', 'composer.placeholder': '輸入訊息',
    'doctor.nearTimeout': '判斷：{count} 次 Bash 呼叫在約 300 秒結束，符合工具逾時特徵；trace 無法單獨證明觸發逾時的根因。下一步檢查這些呼叫的 shell 完成標記和終端錯誤。',
    'doctor.logs.none': '日誌檔尚未建立；舊版主控台日誌未持久化，無法回溯。',
    'doctor.evidence': '診斷證據：{traces} 個近期工作階段、{logs} 筆 warning/error。',
    'doctor.noFindings': '近期 trace 中未發現明確的逾時、未完成工具呼叫或錯誤事件。',
    'doctor.noRoute': '沒有可用的模型路由，無法執行模型分析。',
    'doctor.scope': '證據範圍：{traces} 個近期工作階段、{logs} 筆 warning/error；未讀取對話內容、工具參數或工具輸出。',
    'doctor.failed': '模型分析未完成：{error}。',
  },
  ja: {
    'activity.replying': '応答中', 'activity.thinking': '思考中', 'activity.running': '実行中',
    'activity.turn': '今回のターン', 'activity.interrupt': 'Esc で中断',
    'agents.running': '実行中', 'agents.idle': '待機中', 'agents.done': '完了', 'agents.total': '合計',
    'welcome.model': 'モデル', 'welcome.effort': '推論', 'welcome.project': 'プロジェクト',
    'verbose.on': '詳細モード オン：思考とツール呼び出しをチャットに表示します', 'verbose.off': '詳細モード オフ',
    'mouse.on': 'マウス キャプチャ オン：ホイールでチャットをスクロール · Shift（iTerm2 は Option、Terminal は Fn）を押しながらドラッグでテキスト選択',
    'mouse.off': 'マウス キャプチャ オフ：自由に選択・コピーできます · PageUp/PageDown でスクロール · /mouse で再びオン',
    'language.current': '言語：{name} · /language en | zh-CN | zh-TW | ja | ko | es',
    'language.set': '言語 → {name}', 'language.title': '/language — 表示言語', 'language.currentMark': '現在', 'language.unknown': '不明な言語 "{value}"。en、zh-CN、zh-TW、ja、ko、es から選んでください。',
    'language.saveFailed': '言語設定の保存に失敗しました：{error}',
    'doctor.logs.new': 'この TUI バージョンの起動以降の warning/error のみ記録されています。',
    'footer.current': '現在', 'footer.average': '平均', 'footer.context': 'コンテキスト', 'footer.cache': 'キャッシュ', 'composer.placeholder': 'メッセージを入力',
    'doctor.nearTimeout': '判断：Bash 呼び出し {count} 件が約 300 秒で終了しており、ツールのタイムアウトの特徴に一致します。トレースだけでは根本原因を証明できません。次はこれらの呼び出しのシェル完了マーカーと端末エラーを確認してください。',
    'doctor.logs.none': 'ログファイルはまだありません。以前のコンソールログは保存されておらず、遡れません。',
    'doctor.evidence': '診断の根拠：直近のセッション {traces} 件、warning/error {logs} 件。',
    'doctor.noFindings': '直近のトレースに明確なタイムアウト、未完了ツール、停滞は見つかりませんでした。',
    'doctor.noRoute': '利用できるモデルルートがないため、モデル分析を実行できません。',
    'doctor.scope': '根拠の範囲：直近のセッション {traces} 件、warning/error {logs} 件。会話本文、ツール引数、ツール出力は読んでいません。',
    'doctor.failed': 'モデル分析が完了しませんでした：{error}。',
  },
  ko: {
    'activity.replying': '응답 중', 'activity.thinking': '생각 중', 'activity.running': '실행 중',
    'activity.turn': '이번 턴', 'activity.interrupt': 'Esc 중단',
    'agents.running': '실행 중', 'agents.idle': '대기', 'agents.done': '완료', 'agents.total': '전체',
    'welcome.model': '모델', 'welcome.effort': '추론', 'welcome.project': '프로젝트',
    'verbose.on': '상세 모드 켜짐: 생각과 도구 호출을 채팅에 표시합니다', 'verbose.off': '상세 모드 꺼짐',
    'mouse.on': '마우스 캡처 켜짐: 휠로 채팅 스크롤 · Shift(iTerm2는 Option, Terminal은 Fn)를 누른 채 드래그하여 텍스트 선택',
    'mouse.off': '마우스 캡처 꺼짐: 자유롭게 선택·복사 · PageUp/PageDown으로 채팅 스크롤 · /mouse로 다시 켜기',
    'language.current': '언어: {name} · /language en | zh-CN | zh-TW | ja | ko | es',
    'language.set': '언어 → {name}', 'language.title': '/language — 인터페이스 언어', 'language.currentMark': '현재', 'language.unknown': '알 수 없는 언어 "{value}". en, zh-CN, zh-TW, ja, ko, es 중에서 선택하세요.',
    'language.saveFailed': '언어 설정 저장 실패: {error}',
    'doctor.logs.new': '이 TUI 버전 시작 이후의 warning/error만 기록됩니다.',
    'footer.current': '현재', 'footer.average': '평균', 'footer.context': '컨텍스트', 'footer.cache': '캐시', 'composer.placeholder': '메시지를 입력하세요',
    'doctor.nearTimeout': '판단: Bash 호출 {count}건이 약 300초에 종료되어 도구 시간 초과 특징과 일치합니다. 트레이스만으로는 근본 원인을 증명할 수 없습니다. 다음으로 해당 호출의 셸 완료 표시와 터미널 오류를 확인하세요.',
    'doctor.logs.none': '아직 로그 파일이 없습니다. 이전 콘솔 로그는 저장되지 않아 복구할 수 없습니다.',
    'doctor.evidence': '진단 근거: 최근 세션 {traces}개, warning/error {logs}건.',
    'doctor.noFindings': '최근 트레이스에서 명확한 시간 초과, 미완료 도구, 정지는 발견되지 않았습니다.',
    'doctor.noRoute': '사용 가능한 모델 경로가 없어 모델 분석을 실행할 수 없습니다.',
    'doctor.scope': '근거 범위: 최근 세션 {traces}개, warning/error {logs}건. 대화 본문, 도구 인수, 도구 출력은 읽지 않았습니다.',
    'doctor.failed': '모델 분석이 완료되지 않았습니다: {error}.',
  },
  es: {
    'activity.replying': 'Respondiendo', 'activity.thinking': 'Pensando', 'activity.running': 'Ejecutando',
    'activity.turn': 'este turno', 'activity.interrupt': 'Esc para interrumpir',
    'agents.running': 'en ejecución', 'agents.idle': 'inactivo', 'agents.done': 'terminado', 'agents.total': 'en total',
    'welcome.model': 'modelo', 'welcome.effort': 'esfuerzo', 'welcome.project': 'proyecto',
    'verbose.on': 'modo detallado activado: el razonamiento y las llamadas a herramientas se muestran en el chat', 'verbose.off': 'modo detallado desactivado',
    'mouse.on': 'ratón activado: la rueda desplaza el chat · mantén Shift al arrastrar para seleccionar texto (Option en iTerm2, Fn en Terminal)',
    'mouse.off': 'ratón desactivado: selecciona y copia libremente · PageUp/PageDown desplazan el chat · /mouse vuelve a activar la captura',
    'language.current': 'Idioma: {name} · /language en | zh-CN | zh-TW | ja | ko | es',
    'language.set': 'idioma → {name}', 'language.title': '/language — idioma de la interfaz', 'language.currentMark': 'actual', 'language.unknown': 'Idioma desconocido "{value}". Elige en, zh-CN, zh-TW, ja, ko o es.',
    'language.saveFailed': 'no se pudo guardar el idioma: {error}',
    'doctor.logs.new': 'Solo se registran los warnings/errores desde que arrancó esta versión del TUI.',
    'footer.current': 'actual', 'footer.average': 'promedio', 'footer.context': 'contexto', 'footer.cache': 'caché', 'composer.placeholder': 'escribe un mensaje',
    'doctor.nearTimeout': 'Valoración: {count} llamadas a Bash terminaron a unos 300 segundos, lo que coincide con el tiempo de espera de la herramienta; las trazas por sí solas no prueban la causa raíz. A continuación, revisa los marcadores de finalización del shell y los errores de terminal de esas llamadas.',
    'doctor.logs.none': 'Aún no hay archivo de registro; los registros de consola anteriores no se conservaron y no se pueden recuperar.',
    'doctor.evidence': 'Evidencia del diagnóstico: {traces} sesiones recientes, {logs} warnings/errores.',
    'doctor.noFindings': 'No hay tiempos de espera, herramientas sin terminar ni bloqueos claros en las trazas recientes.',
    'doctor.noRoute': 'No hay una ruta de modelo disponible, así que el análisis con modelo no se pudo ejecutar.',
    'doctor.scope': 'Alcance de la evidencia: {traces} sesiones recientes, {logs} warnings/errores; no se leyó el texto de la conversación, los argumentos ni la salida de las herramientas.',
    'doctor.failed': 'El análisis con modelo no terminó: {error}.',
  },
};

export function normalizeLanguage(value) {
  const wanted = String(value ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (!wanted) return null;
  for (const [code, aliases] of Object.entries(ALIASES)) if (aliases.includes(wanted) || code.toLowerCase() === wanted) return code;
  return null;
}

export function languageName(code) {
  return LANGUAGES.find(language => language.code === code)?.name ?? code;
}

export function t(locale, key, params) {
  const table = MESSAGES[locale] ?? MESSAGES.en;
  let text = table[key] ?? MESSAGES.en[key] ?? key;
  if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
  return text;
}

export function languageFile(home = homedir()) {
  return join(home, '.dsh', 'dsh-code', 'language.json');
}

/** The stored language, or English; DSCODE_LANGUAGE overrides the file for one process. */
export function readLanguage({ home = homedir(), env = process.env } = {}) {
  const override = normalizeLanguage(env.DSCODE_LANGUAGE);
  if (override) return override;
  try {
    const file = languageFile(home);
    if (!existsSync(file)) return 'en';
    return normalizeLanguage(JSON.parse(readFileSync(file, 'utf8')).language) ?? 'en';
  } catch { return 'en'; }
}

export function saveLanguage(code, { home = homedir() } = {}) {
  const normalized = normalizeLanguage(code);
  if (!normalized) throw new Error(`Unknown language: ${code}`);
  const file = languageFile(home);
  mkdirSync(join(home, '.dsh', 'dsh-code'), { recursive: true });
  writeFileSync(file, JSON.stringify({ language: normalized }, null, 2) + '\n');
  return normalized;
}

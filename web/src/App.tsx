import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import {
  enterPractice,
  generateCopilot,
  getConfig,
  getFeedbackSummary,
  openOutputDir,
  recordFeedback,
  saveOperatorsJson,
  searchStageSuggestions,
  validateScript,
  type ConfigResponse,
  type FeedbackSummary,
  type GenerationCoreMode,
  type GenerateResponse,
  type StageSuggestion,
} from "./api";
import { normalizePracticeTestResult, type PracticeTestResult } from "../../src/shared/practiceResult";

type ActionName = "generate" | "practice" | "open" | "browse" | "saveOperators" | "feedback" | null;

interface OperatorStatus {
  operatorsPath: string;
  count: number;
}

function asJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function suggestFileName(stage: string, stageName?: string): string {
  const parts = [(stage || "script").trim()];
  if (stageName?.trim() && stageName.trim() !== parts[0]) {
    parts.push(stageName.trim());
  }
  const source = parts.join("_");
  return `${source.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")}.json`;
}

function compactAnalysis(response: GenerateResponse | null): string {
  const analysis = response?.analysis as any;
  if (!response || !analysis) return "";
  return [
    `Stage: ${response.stageName || response.stageId || ""}`,
    `Difficulty: ${analysis.difficulty || "unknown"}`,
    `Enemies: ${analysis.enemyCount ?? 0}; lanes: ${analysis.laneCount ?? 0}`,
    `Pressure windows: ${analysis.pressureWindows?.length ?? 0}`,
  ].join("\n");
}

function suggestionTitle(suggestion: StageSuggestion): string {
  const code = suggestion.code || suggestion.stageName || suggestion.stageId;
  return suggestion.name ? `${code} - ${suggestion.name}` : code;
}

function isExactStageSuggestion(suggestion: StageSuggestion, value: string): boolean {
  const query = value.trim().toLowerCase();
  return [
    suggestion.code,
    suggestion.stageName,
    suggestion.stageId,
    suggestion.name,
  ].some(item => item?.trim().toLowerCase() === query);
}

export default function App() {
  const [configInfo, setConfigInfo] = useState<ConfigResponse | null>(null);
  const [stage, setStage] = useState("GT-1");
  const [stageFocused, setStageFocused] = useState(false);
  const [stageSuggestions, setStageSuggestions] = useState<StageSuggestion[]>([]);
  const [stageSuggestionQuery, setStageSuggestionQuery] = useState("");
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [operatorFilePath, setOperatorFilePath] = useState("");
  const [defaultOperatorPath, setDefaultOperatorPath] = useState("");
  const [operatorsJson, setOperatorsJson] = useState("");
  const [selectedOperatorsJson, setSelectedOperatorsJson] = useState("");
  const [selectedOperatorFileName, setSelectedOperatorFileName] = useState("");
  const [operatorStatus, setOperatorStatus] = useState<OperatorStatus | null>(null);
  const [maaPath, setMaaPath] = useState("");
  const [showOperatorsPaste, setShowOperatorsPaste] = useState(false);
  const [newCandidate, setNewCandidate] = useState(false);
  const [coreMode, setCoreMode] = useState<GenerationCoreMode>("rule-core");
  const [pretty, setPretty] = useState(true);
  const [outputDir, setOutputDir] = useState("");
  const [fileName, setFileName] = useState("");
  const [jsonPreview, setJsonPreview] = useState("");
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [practiceTestResult, setPracticeTestResult] = useState<PracticeTestResult | "">("");
  const [loading, setLoading] = useState<ActionName>(null);
  const [copiedJson, setCopiedJson] = useState(false);
  const [copiedDebug, setCopiedDebug] = useState(false);
  const [feedbackKilled, setFeedbackKilled] = useState("");
  const [feedbackTotal, setFeedbackTotal] = useState("");
  const [feedbackNotes, setFeedbackNotes] = useState("");
  const [feedbackStatus, setFeedbackStatus] = useState("");
  const [feedbackSummary, setFeedbackSummary] = useState<FeedbackSummary | null>(null);
  const operatorFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    getConfig().then(config => {
      if (config.success) {
        setConfigInfo(config);
        setOutputDir(config.defaultOutputDir);
        setDefaultOperatorPath(config.defaultOperatorsPath || "");
        setMaaPath(config.savedMaaPath || config.detectedMaaPath || "");
        if (config.configuredOperators) {
          setOperatorFilePath(config.configuredOperators.operatorsPath);
          setOperatorStatus({
            operatorsPath: config.configuredOperators.operatorsPath,
            count: config.configuredOperators.count,
          });
        }
      } else {
        setErrors(config.errors || ["加载配置失败"]);
      }
    }).catch(err => setErrors([String(err)]));
  }, []);

  useEffect(() => {
    const query = stage.trim();
    if (query.length < 1) {
      setStageSuggestions([]);
      setStageSuggestionQuery("");
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchStageSuggestions(query).then(response => {
        if (cancelled) return;
        setStageSuggestions(response.success ? response.suggestions || [] : []);
        setStageSuggestionQuery(query);
        setActiveSuggestion(0);
      }).catch(() => {
        if (!cancelled) {
          setStageSuggestions([]);
          setStageSuggestionQuery(query);
        }
      });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [stage]);

  useEffect(() => {
    if (!result?.stageId || !result.scriptHash) {
      setFeedbackSummary(null);
      return;
    }

    let cancelled = false;
    getFeedbackSummary(result.stageName || result.stageId).then(response => {
      if (!cancelled) setFeedbackSummary(response.success ? response.summary || null : null);
    }).catch(() => {
      if (!cancelled) setFeedbackSummary(null);
    });

    return () => {
      cancelled = true;
    };
  }, [result?.stageId, result?.stageName, result?.scriptHash]);

  const defaultFileName = useMemo(() => suggestFileName(stage), [stage]);
  const analysisSummary = compactAnalysis(result);
  const stageQuery = stage.trim();
  const stageSuggestionReady = stageSuggestionQuery === stageQuery;
  const hasUniqueExactStage = stageSuggestions.length === 1 && isExactStageSuggestion(stageSuggestions[0], stageQuery);
  const canShowSuggestions = stageFocused && stageQuery.length >= 1 && stageSuggestionReady && stageSuggestions.length > 0 && !hasUniqueExactStage;
  const canShowInvalidStage = stageFocused && stageQuery.length >= 1 && stageSuggestionReady && stageSuggestions.length === 0;

  function operatorPayload() {
    const manualPath = operatorFilePath.trim();
    if (manualPath) {
      return { operatorFilePath: manualPath, operatorsJson: undefined };
    }

    return {
      operatorFilePath: undefined,
      operatorsJson: selectedOperatorsJson || (showOperatorsPaste && operatorsJson.trim() ? operatorsJson : undefined),
    };
  }

  function chooseStage(suggestion: StageSuggestion) {
    setStage(suggestion.code || suggestion.stageName || suggestion.stageId);
    setStageSuggestions([]);
    setStageSuggestionQuery("");
  }

  function handleStageKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!canShowSuggestions) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestion(index => Math.min(index + 1, stageSuggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestion(index => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      chooseStage(stageSuggestions[activeSuggestion]);
    } else if (event.key === "Escape") {
      setStageFocused(false);
    }
  }

  async function runGenerate() {
    setLoading("generate");
    setStatusMessage("");
    setPracticeTestResult("");
    setErrors([]);
    setWarnings([]);
    setCopiedJson(false);
    setCopiedDebug(false);
    try {
      const response = await generateCopilot({
        stage,
        ...operatorPayload(),
        pretty,
        outputDir,
        fileName: fileName.trim() || undefined,
        newCandidate,
        core: coreMode,
      });
      setWarnings(response.warnings || []);
      setResult(response);
      if (!response.success) {
        setErrors(response.errors || ["生成失败"]);
        return;
      }
      if (response.outputDir) setOutputDir(response.outputDir);
      setJsonPreview(response.json || asJson(response.script));
      const enemyTotal = (response.analysis as any)?.enemyCount;
      if (Number.isInteger(enemyTotal) && enemyTotal > 0) setFeedbackTotal(String(enemyTotal));
      setFeedbackStatus("");
      setFileName("");
    } catch (err) {
      setErrors([String(err)]);
    } finally {
      setLoading(null);
    }
  }

  async function runValidateAndEnterPractice() {
    const stageName = stage.trim();
    if (!stageName) {
      setErrors(["关卡为空"]);
      return;
    }
    if (!jsonPreview.trim()) {
      setErrors(["请先生成脚本"]);
      return;
    }
    if (!result?.outputPath) {
      setErrors(["请先生成脚本文件"]);
      return;
    }

    setLoading("practice");
    setStatusMessage("");
    setPracticeTestResult("");
    setErrors([]);
    setWarnings([]);
    let validationPassed = false;
    try {
      const validationResponse = await validateScript(jsonPreview);
      if (!validationResponse.success) {
        setPracticeTestResult("失败");
        setWarnings(validationResponse.warnings || []);
        setErrors(validationResponse.errors || ["验证失败"]);
        return;
      }
      validationPassed = true;
      setResult(prev => ({
        ...(prev || { success: true }),
        success: true,
        validation: validationResponse.validation,
        protocol: validationResponse.protocol,
        warnings: validationResponse.warnings || [],
        errors: [],
      }));

      const response = await enterPractice(stageName, maaPath.trim() || undefined, result?.scriptHash, result.outputPath);
      setWarnings([...(validationResponse.warnings || []), ...(response.warnings || [])]);
      if (!response.success) {
        setPracticeTestResult("进入失败");
        setErrors(response.errors || ["进入演习失败"]);
        return;
      }
      const testResult = normalizePracticeTestResult(response.result);
      setPracticeTestResult(testResult);
      setStatusMessage(testResult ? `测试结果：${testResult}` : `脚本验证通过，已执行 ${response.result?.stage || stageName} 演习作业${response.result?.closedProxy ? "，已关闭代理指挥" : ""}`);
      if (response.result?.feedbackRecord) {
        setFeedbackStatus(response.result.feedbackRecord.usableForLearning ? "测试结果已加入可学习反馈" : "测试结果已记录，仅用于统计");
        if (result?.stageId) {
          try {
            const summaryResponse = await getFeedbackSummary(result.stageName || result.stageId);
            if (summaryResponse.success) setFeedbackSummary(summaryResponse.summary || null);
          } catch {
            setFeedbackSummary(null);
          }
        }
      }
    } catch (err) {
      setPracticeTestResult(validationPassed ? "进入失败" : "失败");
      setErrors([String(err)]);
    } finally {
      setLoading(null);
    }
  }

  async function runFeedback() {
    if (!result?.scriptHash) {
      setErrors(["当前结果没有可关联的脚本 hash"]);
      return;
    }
    const killed = Number(feedbackKilled);
    const total = feedbackTotal.trim() ? Number(feedbackTotal) : undefined;
    setLoading("feedback");
    setStatusMessage("");
    setErrors([]);
    try {
      const response = await recordFeedback({
        scriptHash: result.scriptHash,
        killed,
        total,
        notes: feedbackNotes,
      });
      if (!response.success || !response.record) {
        setErrors(response.errors || ["反馈保存失败"]);
        return;
      }
      setFeedbackStatus(`已记录歼灭率 ${(response.record.ratio * 100).toFixed(1)}%${response.record.usableForLearning ? "，将用于后续候选" : "，仅用于统计"}`);
      setFeedbackKilled("");
      setFeedbackTotal("");
      setFeedbackNotes("");
      if (result.stageId) {
        try {
          const summaryResponse = await getFeedbackSummary(result.stageName || result.stageId);
          if (summaryResponse.success) setFeedbackSummary(summaryResponse.summary || null);
        } catch {
          setFeedbackSummary(null);
        }
      }
    } catch (err) {
      setErrors([String(err)]);
    } finally {
      setLoading(null);
    }
  }

  async function runOpenOutputDir() {
    setLoading("open");
    setStatusMessage("");
    setErrors([]);
    try {
      const response = await openOutputDir(result?.outputDir || outputDir);
      if (!response.success) {
        setErrors(response.errors || ["打开输出目录失败"]);
        return;
      }
      if (response.outputDir) setOutputDir(response.outputDir);
    } catch (err) {
      setErrors([String(err)]);
    } finally {
      setLoading(null);
    }
  }

  function browseOperatorPath() {
    operatorFileInputRef.current?.click();
  }

  async function handleOperatorFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setLoading("browse");
    setStatusMessage("");
    setErrors([]);
    setWarnings([]);
    try {
      const text = await file.text();
      JSON.parse(text);
      setSelectedOperatorsJson(text);
      setSelectedOperatorFileName(file.name);
      setOperatorFilePath("");
      setOperatorsJson("");
      setShowOperatorsPaste(false);
    } catch (err) {
      setSelectedOperatorsJson("");
      setSelectedOperatorFileName("");
      setErrors([`读取 operators JSON 失败：${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      event.target.value = "";
      setLoading(null);
    }
  }

  async function savePastedOperators() {
    if (!operatorsJson.trim()) {
      setErrors(["operators JSON 为空"]);
      return;
    }

    setLoading("saveOperators");
    setStatusMessage("");
    setErrors([]);
    setWarnings([]);
    try {
      const response = await saveOperatorsJson(operatorsJson);
      if (!response.success) {
        setErrors(response.errors || ["保存干员库失败"]);
        return;
      }
      setOperatorStatus({
        operatorsPath: response.operatorsPath || "",
        count: response.count || 0,
      });
      setOperatorFilePath("");
      setSelectedOperatorsJson("");
      setSelectedOperatorFileName("");
      setOperatorsJson("");
      setShowOperatorsPaste(false);
      setWarnings(response.warnings || []);
    } catch (err) {
      setErrors([String(err)]);
    } finally {
      setLoading(null);
    }
  }

  async function copyJson() {
    if (!jsonPreview) return;
    await navigator.clipboard.writeText(jsonPreview);
    setCopiedJson(true);
  }

  async function copyDebugInfo() {
    const debugInfo = {
      version: configInfo?.version || "unknown",
      time: new Date().toISOString(),
      url: window.location.href,
      userAgent: navigator.userAgent,
      homeDir: configInfo?.homeDir,
      outputDir: result?.outputDir || outputDir || configInfo?.defaultOutputDir,
      outputPath: result?.outputPath,
      cacheDir: configInfo?.defaultCacheDir,
      logDir: configInfo?.defaultLogDir,
      maaPath,
      stage,
      engine: "v2",
      coreMode,
      selectedCore: result?.selectedCore,
      pretty,
      fileName: fileName || result?.fileName,
      warningCount: warnings.length,
      errorCount: errors.length,
      warnings,
      errors,
    };
    await navigator.clipboard.writeText(JSON.stringify(debugInfo, null, 2));
    setCopiedDebug(true);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>MAAfight</h1>
          <p>Copilot JSON Generator</p>
        </div>
        <span className="status-dot">Local {configInfo?.version || ""}</span>
      </header>

      <section className="grid">
        <div className="panel">
          <h2>基本设置</h2>
          <label className="stage-field">
            <span>关卡 ID / 关卡名</span>
            <input
              value={stage}
              onChange={e => setStage(e.target.value)}
              onFocus={() => setStageFocused(true)}
              onBlur={() => window.setTimeout(() => setStageFocused(false), 120)}
              onKeyDown={handleStageKeyDown}
              placeholder="GT-1 / 3-8 / 0-1"
              autoComplete="off"
            />
            {canShowSuggestions && (
              <div className="stage-suggestions">
                {stageSuggestions.map((suggestion, index) => (
                  <button
                    type="button"
                    className={`stage-option ${index === activeSuggestion ? "active" : ""}`}
                    key={`${suggestion.stageId}-${suggestion.code || ""}`}
                    onMouseDown={event => {
                      event.preventDefault();
                      chooseStage(suggestion);
                    }}
                  >
                    <span className="stage-option-main">
                      <strong>{suggestionTitle(suggestion)}</strong>
                      <small>{suggestion.stageId}</small>
                    </span>
                    <span className="stage-option-tags">
                      <em>系列 {suggestion.series || "-"}</em>
                      <em>序号 {suggestion.number || "-"}</em>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {canShowInvalidStage && (
              <div className="stage-suggestions">
                <div className="stage-empty">未找到关卡</div>
              </div>
            )}
          </label>

          <label>
            <span>operators JSON 文件路径</span>
            <div className="inline-input">
              <input
                value={operatorFilePath}
                onChange={e => {
                  setOperatorFilePath(e.target.value);
                  if (e.target.value.trim()) {
                    setSelectedOperatorsJson("");
                    setSelectedOperatorFileName("");
                  }
                }}
                placeholder={defaultOperatorPath || "C:\\...\\Arknights_OperBox_Export.json"}
              />
              <button type="button" className="secondary" onClick={browseOperatorPath} disabled={loading !== null}>
                {loading === "browse" ? "打开中..." : "浏览"}
              </button>
              <input
                ref={operatorFileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden-file-input"
                onChange={handleOperatorFileSelected}
              />
            </div>
            {selectedOperatorFileName && !operatorFilePath.trim() && (
              <p className="hint">已从资源管理器载入：{selectedOperatorFileName}。浏览器不会暴露完整路径，生成时会使用该文件内容。</p>
            )}
            {!selectedOperatorFileName && !operatorFilePath.trim() && defaultOperatorPath && (
              <p className="hint action-hint">
                默认路径：{defaultOperatorPath}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setOperatorFilePath(defaultOperatorPath)}
                >
                  填入默认路径
                </button>
              </p>
            )}
          </label>

          <label>
            <span>MAA 路径</span>
            <input
              value={maaPath}
              onChange={e => setMaaPath(e.target.value)}
              placeholder={configInfo?.detectedMaaPath || "C:\\...\\MAA 或 MAA.exe"}
            />
            {configInfo?.detectedMaaPath && maaPath.trim() !== configInfo.detectedMaaPath && (
              <p className="hint action-hint">
                检测到：{configInfo.detectedMaaPath}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setMaaPath(configInfo.detectedMaaPath || "")}
                >
                  填入检测路径
                </button>
              </p>
            )}
          </label>

          <fieldset className="core-mode">
            <legend>生成模式</legend>
            <div className="segmented-control">
              {([
                ["rule-core", "传统"],
                ["model-core", "模型"],
                ["hybrid-core", "综合"],
              ] as const).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="core-mode"
                    value={value}
                    checked={coreMode === value}
                    onChange={() => setCoreMode(value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="operator-card">
            <div>
              <span className="section-label">本地干员库</span>
              {operatorStatus ? (
                <p className="operator-status">已保存 {operatorStatus.count} 名干员：{operatorStatus.operatorsPath}</p>
              ) : (
                <p className="operator-status muted">未保存本地干员库</p>
              )}
            </div>
            {!showOperatorsPaste && (
              <button type="button" className="secondary" onClick={() => setShowOperatorsPaste(true)}>
                粘贴 JSON
              </button>
            )}
          </div>

          {showOperatorsPaste && (
            <div className="paste-panel">
              <label>
                <span>operators JSON 粘贴</span>
                <textarea
                  value={operatorsJson}
                  onChange={e => setOperatorsJson(e.target.value)}
                  className="operator-json"
                  placeholder='[{ "name": "推进之王", "own": true, ... }]'
                />
              </label>
              <div className="paste-actions">
                <button type="button" onClick={savePastedOperators} disabled={loading !== null}>
                  {loading === "saveOperators" ? "保存中..." : "保存为默认干员库"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setShowOperatorsPaste(false);
                    setOperatorsJson("");
                  }}
                  disabled={loading !== null}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          <label className="toggle">
            <input type="checkbox" checked={newCandidate} onChange={e => setNewCandidate(e.target.checked)} />
            <span>忽略已成功版本，生成新候选</span>
          </label>

          <label className="toggle">
            <input type="checkbox" checked={pretty} onChange={e => setPretty(e.target.checked)} />
            <span>pretty JSON</span>
          </label>
        </div>

        <div className="panel">
          <h2>输出设置</h2>
          <label>
            <span>输出目录</span>
            <input value={outputDir} onChange={e => setOutputDir(e.target.value)} />
          </label>
          <label>
            <span>文件名</span>
            <input value={fileName} onChange={e => setFileName(e.target.value)} placeholder={defaultFileName} />
          </label>
          <p className="hint">留空时自动使用：{defaultFileName}</p>
          {result?.outputPath && <p className="saved">已保存到：{result.outputPath}</p>}
          {configInfo && (
            <div className="runtime-info">
              <p>运行目录：{configInfo.homeDir}</p>
              <p>缓存目录：{configInfo.defaultCacheDir}</p>
              <p>日志目录：{configInfo.defaultLogDir}</p>
            </div>
          )}
        </div>

        <div className="panel actions">
          <h2>操作</h2>
          <button onClick={runGenerate} disabled={loading !== null}>{loading === "generate" ? "分析生成中..." : "分析并生成脚本"}</button>
          <button onClick={runValidateAndEnterPractice} disabled={loading !== null || !jsonPreview}>{loading === "practice" ? "验证进入中..." : "验证脚本并进入演习"}</button>
          <button onClick={runOpenOutputDir} disabled={loading !== null}>{loading === "open" ? "打开中..." : "打开输出目录"}</button>
          <button className="secondary" onClick={copyDebugInfo} disabled={!configInfo}>{copiedDebug ? "已复制调试信息" : "复制调试信息"}</button>
        </div>

        <div className="panel result">
          <h2>结果</h2>
          {errors.length > 0 && <div className="alert error">{errors.map((e, i) => <p key={i}>{e}</p>)}</div>}
          {warnings.length > 0 && <div className="alert warning">{warnings.map((w, i) => <p key={i}>{w}</p>)}</div>}
          {practiceTestResult && (
            <div className={`alert ${practiceTestResult === "三星" ? "success" : practiceTestResult === "二星" ? "warning" : "error"}`}>
              <p>测试结果：{practiceTestResult}</p>
            </div>
          )}
          {statusMessage && errors.length === 0 && !practiceTestResult && <div className="alert success"><p>{statusMessage}</p></div>}
          {!statusMessage && !practiceTestResult && result?.success && errors.length === 0 && <div className="alert success"><p>成功</p></div>}
          {analysisSummary && <pre className="summary">{analysisSummary}</pre>}
          {result?.requestedCore && <p className="hint">生成模式：{result.requestedCore}；采用：{result.selectedCore || "-"}</p>}
          {result?.explain && <pre className="summary">{result.explain}</pre>}
          {result?.validation !== undefined && <pre className="summary">{asJson(result.validation)}</pre>}
          {result?.scriptHash && (
            <div className="paste-panel">
              <span className="section-label">实战反馈</span>
              <p className="hint">候选评分：{result.candidateScore?.toFixed(2) ?? "-"}；模型：{result.modelVersion || "-"}</p>
              <p className="hint">
                已记录 {feedbackSummary?.count ?? 0} 次；可学习 {feedbackSummary?.usableCount ?? 0} 次；满歼 {feedbackSummary?.fullClearCount ?? 0} 次
              </p>
              <label>
                <span>击杀数</span>
                <input value={feedbackKilled} onChange={e => setFeedbackKilled(e.target.value)} inputMode="numeric" />
              </label>
              <label>
                <span>敌人总数</span>
                <input value={feedbackTotal} onChange={e => setFeedbackTotal(e.target.value)} inputMode="numeric" />
              </label>
              <label>
                <span>备注</span>
                <input value={feedbackNotes} onChange={e => setFeedbackNotes(e.target.value)} />
              </label>
              <button type="button" onClick={runFeedback} disabled={loading !== null || !feedbackKilled.trim()}>
                {loading === "feedback" ? "保存中..." : "记录实战结果"}
              </button>
              {feedbackStatus && <p className="saved">{feedbackStatus}</p>}
            </div>
          )}
        </div>
      </section>

      <section className="panel preview">
        <div className="preview-head">
          <h2>JSON 预览</h2>
          <button onClick={copyJson} disabled={!jsonPreview}>{copiedJson ? "已复制" : "复制 JSON"}</button>
        </div>
        <textarea value={jsonPreview} readOnly placeholder="生成后显示 JSON" />
      </section>
    </main>
  );
}

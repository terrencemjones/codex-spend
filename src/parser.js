const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

function getCodexDir() {
  return path.join(os.homedir(), '.codex');
}

async function parseJSONLFile(filePath) {
  const lines = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  return lines;
}

function walkSessionFiles(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function toNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function usageToQueryFields(usage) {
  const inputTokens = toNumber(usage?.input_tokens);
  const outputTokens = toNumber(usage?.output_tokens);
  const totalTokens = toNumber(usage?.total_tokens) || (inputTokens + outputTokens);

  return { inputTokens, outputTokens, totalTokens };
}

function subtractUsage(current, previous) {
  const inputTokens = Math.max(0, toNumber(current?.input_tokens) - toNumber(previous?.input_tokens));
  const outputTokens = Math.max(0, toNumber(current?.output_tokens) - toNumber(previous?.output_tokens));
  const totalTokens = Math.max(0, toNumber(current?.total_tokens) - toNumber(previous?.total_tokens));

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

function normalizeUserMessage(payload) {
  if (!payload) return null;

  let text = '';

  if (typeof payload.message === 'string') {
    text = payload.message;
  }

  if (!text && Array.isArray(payload.text_elements)) {
    text = payload.text_elements
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  text = text.trim();
  if (!text) return null;

  // Skip short slash commands such as /exit
  if (text.startsWith('/') && text.length <= 40) return null;

  return text;
}

function extractSessionId(filePath, sessionMeta) {
  const metaId = sessionMeta?.payload?.id;
  if (metaId) return metaId;

  const base = path.basename(filePath, '.jsonl');
  const match = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : base;
}

function extractDate(filePath, timestamp) {
  if (timestamp && typeof timestamp === 'string' && timestamp.includes('T')) {
    return timestamp.split('T')[0];
  }

  const match = filePath.match(/sessions[\\/](\d{4})[\\/](\d{2})[\\/](\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  return 'unknown';
}

function extractSessionData(entries, fallbackModel = 'unknown') {
  const queries = [];
  let pendingUserMessage = null;
  let currentModel = fallbackModel;
  let previousCumulativeUsage = null;

  for (const entry of entries) {
    if (entry.type === 'turn_context' && entry.payload?.model) {
      currentModel = entry.payload.model;
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
      const text = normalizeUserMessage(entry.payload);
      if (text) {
        pendingUserMessage = {
          text,
          timestamp: entry.timestamp || null,
        };
      }
      continue;
    }

    if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') {
      continue;
    }

    const info = entry.payload.info;
    if (!info) continue;

    const cumulativeUsage = info.total_token_usage || null;
    if (
      cumulativeUsage
      && previousCumulativeUsage
      && toNumber(cumulativeUsage.total_tokens) <= toNumber(previousCumulativeUsage.total_tokens)
    ) {
      // Duplicate emission with no extra usage
      continue;
    }

    let stepUsage = info.last_token_usage || null;
    if (!stepUsage && cumulativeUsage) {
      stepUsage = previousCumulativeUsage
        ? subtractUsage(cumulativeUsage, previousCumulativeUsage)
        : cumulativeUsage;
    }

    if (!stepUsage) {
      if (cumulativeUsage) previousCumulativeUsage = cumulativeUsage;
      continue;
    }

    const { inputTokens, outputTokens, totalTokens } = usageToQueryFields(stepUsage);
    if (totalTokens <= 0) {
      if (cumulativeUsage) previousCumulativeUsage = cumulativeUsage;
      continue;
    }

    const userPrompt = pendingUserMessage?.text || null;
    const userTimestamp = pendingUserMessage?.timestamp || null;
    pendingUserMessage = null;

    queries.push({
      userPrompt,
      userTimestamp,
      assistantTimestamp: entry.timestamp || null,
      model: currentModel || 'unknown',
      inputTokens,
      outputTokens,
      totalTokens,
    });

    if (cumulativeUsage) previousCumulativeUsage = cumulativeUsage;
  }

  return queries;
}

function getPrimaryModel(queries) {
  const modelCounts = {};
  for (const query of queries) {
    const model = query.model || 'unknown';
    modelCounts[model] = (modelCounts[model] || 0) + 1;
  }

  return Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
}

function projectLabel(projectPath) {
  if (!projectPath || projectPath === 'unknown') return 'unknown';
  const normalized = projectPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return projectPath;
  if (parts.length === 1) return parts[0];
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

async function parseAllSessions() {
  const codexDir = getCodexDir();
  const sessionsDir = path.join(codexDir, 'sessions');

  if (!fs.existsSync(sessionsDir)) {
    return { sessions: [], dailyUsage: [], modelBreakdown: [], topPrompts: [], totals: {}, insights: [] };
  }

  const historyPath = path.join(codexDir, 'history.jsonl');
  const historyEntries = fs.existsSync(historyPath) ? await parseJSONLFile(historyPath) : [];
  const sessionFirstPrompt = {};

  for (const entry of historyEntries) {
    const sessionId = entry.session_id || entry.sessionId;
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (!sessionId || !text || sessionFirstPrompt[sessionId]) continue;
    if (text.startsWith('/') && text.length <= 40) continue;
    sessionFirstPrompt[sessionId] = text;
  }

  const files = walkSessionFiles(sessionsDir);
  const sessions = [];
  const dailyMap = {};
  const modelMap = {};
  const allPrompts = [];

  for (const filePath of files) {
    let entries;
    try {
      entries = await parseJSONLFile(filePath);
    } catch {
      continue;
    }
    if (entries.length === 0) continue;

    const sessionMeta = entries.find((entry) => entry.type === 'session_meta');
    const sessionId = extractSessionId(filePath, sessionMeta);
    const project = sessionMeta?.payload?.cwd || 'unknown';
    const fallbackModel = sessionMeta?.payload?.model || 'unknown';
    const sessionTimestamp = sessionMeta?.payload?.timestamp
      || entries.find((entry) => entry.timestamp)?.timestamp
      || null;

    const queries = extractSessionData(entries, fallbackModel);
    if (queries.length === 0) continue;

    let inputTokens = 0;
    let outputTokens = 0;
    for (const query of queries) {
      inputTokens += query.inputTokens;
      outputTokens += query.outputTokens;
    }
    const totalTokens = inputTokens + outputTokens;

    const date = extractDate(filePath, sessionTimestamp || queries[0]?.assistantTimestamp);
    const primaryModel = getPrimaryModel(queries);
    const firstPrompt = sessionFirstPrompt[sessionId]
      || queries.find((query) => query.userPrompt)?.userPrompt
      || '(no prompt)';

    // Group query usage by each user prompt to power top prompts.
    let currentPrompt = null;
    let promptInput = 0;
    let promptOutput = 0;

    const flushPrompt = () => {
      if (!currentPrompt) return;
      const promptTotal = promptInput + promptOutput;
      if (promptTotal <= 0) return;
      allPrompts.push({
        prompt: currentPrompt.substring(0, 300),
        inputTokens: promptInput,
        outputTokens: promptOutput,
        totalTokens: promptTotal,
        date,
        sessionId,
        model: primaryModel,
      });
    };

    for (const query of queries) {
      if (query.userPrompt) {
        flushPrompt();
        currentPrompt = query.userPrompt;
        promptInput = 0;
        promptOutput = 0;
      }

      if (currentPrompt) {
        promptInput += query.inputTokens;
        promptOutput += query.outputTokens;
      }
    }
    flushPrompt();

    sessions.push({
      sessionId,
      project,
      date,
      timestamp: sessionTimestamp,
      firstPrompt: firstPrompt.substring(0, 200),
      model: primaryModel,
      queryCount: queries.length,
      queries,
      inputTokens,
      outputTokens,
      totalTokens,
    });

    if (date !== 'unknown') {
      if (!dailyMap[date]) {
        dailyMap[date] = {
          date,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          sessions: 0,
          queries: 0,
        };
      }
      dailyMap[date].inputTokens += inputTokens;
      dailyMap[date].outputTokens += outputTokens;
      dailyMap[date].totalTokens += totalTokens;
      dailyMap[date].sessions += 1;
      dailyMap[date].queries += queries.length;
    }

    for (const query of queries) {
      if (!query.model || query.model === 'unknown') continue;
      if (!modelMap[query.model]) {
        modelMap[query.model] = {
          model: query.model,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          queryCount: 0,
        };
      }
      modelMap[query.model].inputTokens += query.inputTokens;
      modelMap[query.model].outputTokens += query.outputTokens;
      modelMap[query.model].totalTokens += query.totalTokens;
      modelMap[query.model].queryCount += 1;
    }
  }

  sessions.sort((a, b) => b.totalTokens - a.totalTokens);
  const dailyUsage = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  allPrompts.sort((a, b) => b.totalTokens - a.totalTokens);
  const topPrompts = allPrompts.slice(0, 20);

  const totals = {
    totalSessions: sessions.length,
    totalQueries: sessions.reduce((sum, session) => sum + session.queryCount, 0),
    totalTokens: sessions.reduce((sum, session) => sum + session.totalTokens, 0),
    totalInputTokens: sessions.reduce((sum, session) => sum + session.inputTokens, 0),
    totalOutputTokens: sessions.reduce((sum, session) => sum + session.outputTokens, 0),
    avgTokensPerQuery: 0,
    avgTokensPerSession: 0,
    dateRange: dailyUsage.length > 0
      ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date }
      : null,
  };

  if (totals.totalQueries > 0) {
    totals.avgTokensPerQuery = Math.round(totals.totalTokens / totals.totalQueries);
  }
  if (totals.totalSessions > 0) {
    totals.avgTokensPerSession = Math.round(totals.totalTokens / totals.totalSessions);
  }

  const insights = generateInsights(sessions, allPrompts, totals);

  return {
    sessions,
    dailyUsage,
    modelBreakdown: Object.values(modelMap).sort((a, b) => b.totalTokens - a.totalTokens),
    topPrompts,
    totals,
    insights,
  };
}

function generateInsights(sessions, allPrompts, totals) {
  const insights = [];

  const shortExpensive = allPrompts.filter((prompt) => prompt.prompt.trim().length < 30 && prompt.totalTokens > 100_000);
  if (shortExpensive.length > 0) {
    const totalWasted = shortExpensive.reduce((sum, prompt) => sum + prompt.totalTokens, 0);
    const examples = [...new Set(shortExpensive.map((prompt) => prompt.prompt.trim()))].slice(0, 4);
    insights.push({
      id: 'vague-prompts',
      type: 'warning',
      title: 'Short, vague messages are costing you the most',
      description: `${shortExpensive.length} times you sent a short message like ${examples.map((example) => `"${example}"`).join(', ')}. These prompts triggered expensive runs totaling ${fmt(totalWasted)} tokens.`,
      action: 'Use specific instructions with file names and expected output to reduce extra exploration.',
    });
  }

  const longSessions = sessions.filter((session) => session.queries.length > 50);
  if (longSessions.length > 0) {
    const growthData = longSessions
      .map((session) => {
        const first5 = session.queries.slice(0, 5).reduce((sum, query) => sum + query.totalTokens, 0)
          / Math.min(5, session.queries.length);
        const last5 = session.queries.slice(-5).reduce((sum, query) => sum + query.totalTokens, 0)
          / Math.min(5, session.queries.length);
        return { session, ratio: last5 / Math.max(first5, 1) };
      })
      .filter((item) => item.ratio > 2);

    if (growthData.length > 0) {
      const avgGrowth = (growthData.reduce((sum, item) => sum + item.ratio, 0) / growthData.length).toFixed(1);
      const worst = growthData.sort((a, b) => b.ratio - a.ratio)[0];
      insights.push({
        id: 'context-growth',
        type: 'warning',
        title: 'The longer you chat, the more each step costs',
        description: `In ${growthData.length} conversations, late-stage steps were about ${avgGrowth}x more expensive than early steps. The steepest session ("${worst.session.firstPrompt.substring(0, 50)}...") grew ${worst.ratio.toFixed(1)}x.`,
        action: 'Start a fresh conversation when the task changes instead of keeping one long thread.',
      });
    }
  }

  const turnCounts = sessions.map((session) => session.queryCount).sort((a, b) => a - b);
  const medianTurns = turnCounts[Math.floor(turnCounts.length / 2)] || 0;
  const marathonCount = sessions.filter((session) => session.queryCount > 200).length;
  if (marathonCount >= 3) {
    const marathonTokens = sessions
      .filter((session) => session.queryCount > 200)
      .reduce((sum, session) => sum + session.totalTokens, 0);
    const pct = ((marathonTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
    insights.push({
      id: 'marathon-sessions',
      type: 'info',
      title: `${marathonCount} marathon conversations used ${pct}% of all tokens`,
      description: `Those long sessions consumed ${fmt(marathonTokens)} tokens, while your median conversation length is ${medianTurns} steps.`,
      action: 'Keep one conversation per task and close it when you switch topics.',
    });
  }

  if (totals.totalTokens > 0) {
    const outputPct = (totals.totalOutputTokens / totals.totalTokens) * 100;
    if (outputPct < 5) {
      insights.push({
        id: 'input-heavy',
        type: 'info',
        title: `${outputPct.toFixed(1)}% of tokens were output`,
        description: `Out of ${fmt(totals.totalTokens)} total tokens, ${fmt(totals.totalOutputTokens)} were model output. Most usage came from input/context.`,
        action: 'Focus on reducing context length and unnecessary tool loops.',
      });
    }
  }

  if (sessions.length >= 10) {
    const dayOfWeekMap = {};
    for (const session of sessions) {
      if (!session.timestamp) continue;
      const day = new Date(session.timestamp).getDay();
      if (!dayOfWeekMap[day]) dayOfWeekMap[day] = { tokens: 0, sessions: 0 };
      dayOfWeekMap[day].tokens += session.totalTokens;
      dayOfWeekMap[day].sessions += 1;
    }

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = Object.entries(dayOfWeekMap).map(([day, value]) => ({
      day: dayNames[day],
      avg: value.tokens / value.sessions,
    }));

    if (days.length >= 3) {
      days.sort((a, b) => b.avg - a.avg);
      const busiest = days[0];
      const quietest = days[days.length - 1];
      insights.push({
        id: 'day-pattern',
        type: 'neutral',
        title: `Your heaviest usage is on ${busiest.day}s`,
        description: `${busiest.day} conversations average ${fmt(Math.round(busiest.avg))} tokens versus ${fmt(Math.round(quietest.avg))} on ${quietest.day}s.`,
        action: null,
      });
    }
  }

  if (sessions.length >= 5) {
    const toolHeavy = sessions.filter((session) => {
      const userMessages = session.queries.filter((query) => query.userPrompt).length;
      const toolCalls = session.queryCount - userMessages;
      return userMessages > 0 && toolCalls > userMessages * 3;
    });

    if (toolHeavy.length >= 3) {
      const totalToolTokens = toolHeavy.reduce((sum, session) => sum + session.totalTokens, 0);
      const avgRatio = toolHeavy.reduce((sum, session) => {
        const userMessages = session.queries.filter((query) => query.userPrompt).length;
        return sum + ((session.queryCount - userMessages) / Math.max(userMessages, 1));
      }, 0) / toolHeavy.length;

      insights.push({
        id: 'tool-heavy',
        type: 'info',
        title: `${toolHeavy.length} conversations had ${Math.round(avgRatio)}x more tool calls than prompts`,
        description: `Those sessions consumed ${fmt(totalToolTokens)} tokens. Large exploratory tool loops tend to increase spend quickly.`,
        action: 'Point to specific files and expected changes to reduce discovery calls.',
      });
    }
  }

  if (sessions.length >= 5) {
    const projectTokens = {};
    for (const session of sessions) {
      const project = session.project || 'unknown';
      projectTokens[project] = (projectTokens[project] || 0) + session.totalTokens;
    }

    const sorted = Object.entries(projectTokens).sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 2) {
      const [topProject, topTokens] = sorted[0];
      const pct = ((topTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
      if (pct >= 60) {
        insights.push({
          id: 'project-dominance',
          type: 'info',
          title: `${pct}% of tokens came from one project: ${projectLabel(topProject)}`,
          description: `${projectLabel(topProject)} used ${fmt(topTokens)} of ${fmt(totals.totalTokens)} total tokens.`,
          action: 'If needed, split that project work into shorter sessions to reduce context growth.',
        });
      }
    }
  }

  if (sessions.length >= 10) {
    const shortSessions = sessions.filter((session) => session.queryCount >= 3 && session.queryCount <= 15);
    const longSessions2 = sessions.filter((session) => session.queryCount > 80);
    if (shortSessions.length >= 3 && longSessions2.length >= 2) {
      const shortAvg = Math.round(shortSessions.reduce((sum, session) => sum + (session.totalTokens / session.queryCount), 0) / shortSessions.length);
      const longAvg = Math.round(longSessions2.reduce((sum, session) => sum + (session.totalTokens / session.queryCount), 0) / longSessions2.length);
      const ratio = longAvg / Math.max(shortAvg, 1);

      if (ratio >= 2) {
        insights.push({
          id: 'conversation-efficiency',
          type: 'warning',
          title: `Each step costs ${ratio.toFixed(1)}x more in long conversations`,
          description: `Short sessions average ${fmt(shortAvg)} tokens per step; long sessions average ${fmt(longAvg)}.`,
          action: 'Reset context periodically for better token efficiency.',
        });
      }
    }
  }

  if (sessions.length >= 5) {
    const heavyStarts = sessions.filter((session) => {
      const firstQuery = session.queries[0];
      return firstQuery && firstQuery.inputTokens > 50_000;
    });

    if (heavyStarts.length >= 5) {
      const avgStartTokens = Math.round(
        heavyStarts.reduce((sum, session) => sum + session.queries[0].inputTokens, 0) / heavyStarts.length,
      );
      const totalOverhead = heavyStarts.reduce((sum, session) => sum + session.queries[0].inputTokens, 0);

      insights.push({
        id: 'heavy-context',
        type: 'info',
        title: `${heavyStarts.length} conversations started with heavy context`,
        description: `Initial context averaged ${fmt(avgStartTokens)} input tokens (${fmt(totalOverhead)} total across those starts).`,
        action: 'Trim global/project instruction files if they include rarely used content.',
      });
    }
  }

  return insights;
}

function fmt(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(0)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

module.exports = { parseAllSessions };

/* PromptIQ — standalone public demo.
 * The prompt-coaching logic (scoring, classification, term suggestions, rewrites)
 * is ported from the original PromptIQ prototype. All chat content is synthetic.
 * No external API: analysis runs fully in the browser. */
(() => {
  "use strict";

  let activeUseCase = "code";

  const USE_CASES = {
    code: {
      label: "Code Review",
      file: "PromptIQ - Code Review.md",
      example: "Can you find bugs in my code?",
      messages: [
        { kind: "user", text: "Clone this repo." },
        { kind: "assistant", html: "Okay. I will clone the repo and review the code." },
        { kind: "tool", text: "Used 2 tools · Clone repository · Inspect staged diff" },
        { kind: "user", text: "Review my staged changes for logic flaws and security issues. Ignore style and formatting." },
        { kind: "assistant", html: "Understood. I'll review by severity, file/line, impact, and the exact fix." },
        { kind: "tool", text: "PromptIQ skill active · Code Review rubric loaded" },
      ],
    },
    data: {
      label: "Data Analysis",
      file: "PromptIQ - Data Analysis.md",
      example: "Can you analyze this data?",
      messages: [
        { kind: "user", text: "Revenue dipped last week for Product X. Can you help me figure out why?" },
        {
          kind: "assistant",
          html: "Sure — let's break this down. A few common drivers to check:<ul><li>Change in user volume</li><li>Change in conversion rate</li><li>Pricing or discounting shifts</li><li>Regional or segment-specific drops</li></ul>Do you have the underlying data or a query we can start from?",
        },
        {
          kind: "user",
          text: "I have a SQL query that pulls daily revenue and user counts:\n\nSELECT date_trunc('day', ts) AS day,\n       SUM(revenue) AS total_revenue,\n       COUNT(DISTINCT user_id) AS users\nFROM revenue_data\nGROUP BY 1",
        },
        {
          kind: "assistant",
          html: "Great. Let's extend this to diagnose the issue. Add conversion-related metrics and compare week-over-week:<br><br><pre class=\"piq-code-block\">SELECT date_trunc('day', ts) AS day,\n       SUM(revenue) AS total_revenue,\n       COUNT(DISTINCT user_id) AS users,\n       COUNT(*) FILTER (WHERE event = 'Purchase') AS orders,\n       COUNT(*) FILTER (WHERE event = 'Purchase')\n         * 1.0 / COUNT(DISTINCT user_id) AS conversion_rate\nFROM revenue_data\nGROUP BY 1</pre><br>This shows whether the drop is driven by fewer users or lower conversion.",
        },
        { kind: "tool", text: "PromptIQ Data Analysis skill active · KPI driver workflow loaded" },
      ],
    },
    marketing: {
      label: "Marketing Sentiment",
      file: "PromptIQ - Marketing Sentiment.md",
      example: "Can you review this campaign feedback?",
      messages: [
        { kind: "user", text: "I'm seeing mixed feedback on our new campaign. Can you help me analyze sentiment from these customer comments?" },
        {
          kind: "assistant",
          html: "Absolutely. I can help categorize sentiment and surface key themes.<br>Please share a sample of the comments or the dataset.",
        },
        {
          kind: "user",
          text: "Here's a subset:\n\n'Love the new design, feels much more modern'\n'The messaging is confusing, not sure what the product actually does'\n'Pricing seems too high compared to competitors'\n'Finally something that solves my problem—great job!'\n'Too many ads, feels overwhelming'",
        },
        { kind: "tool", text: "PromptIQ Marketing Sentiment skill active · Sentiment and theme rubric loaded" },
      ],
    },
  };

  // ---- helpers --------------------------------------------------------------
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
    })[ch]);
  }
  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function applySuggestion(input, suggestion) {
    if (!suggestion || !suggestion.term) return input;
    const rewrite = suggestion.rewrite != null ? suggestion.rewrite : suggestion.term;
    const re = new RegExp(escapeRegExp(suggestion.term), "i");
    if (!re.test(input)) return input;
    let out = input.replace(re, rewrite);
    // Tidy spacing/punctuation that an edit can introduce.
    out = out
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([.,?!;:])/g, "$1")
      .replace(/\bthe the\b/gi, "the")
      .replace(/\bthis the\b/gi, "the")
      .trim();
    return out;
  }

  function renderInlineUnderlines(input, suggestions, selectedTerm) {
    if (!input || !suggestions.length) return "";
    const matches = [];
    for (const suggestion of suggestions) {
      const re = new RegExp(`\\b${escapeRegExp(suggestion.term)}\\b`, "i");
      const match = input.match(re);
      if (match && typeof match.index === "number") {
        matches.push({ start: match.index, end: match.index + match[0].length, text: match[0], term: suggestion.term });
      }
    }
    matches.sort((a, b) => a.start - b.start);
    let cursor = 0, html = "";
    for (const match of matches) {
      if (match.start < cursor) continue;
      html += `<span>${escapeHtml(input.slice(cursor, match.start))}</span>`;
      html += `<button type="button" class="pc-input-token ${selectedTerm === match.term ? "is-selected" : ""}" data-term="${escapeHtml(match.term)}">${escapeHtml(match.text)}</button>`;
      cursor = match.end;
    }
    html += `<span>${escapeHtml(input.slice(cursor))}</span>`;
    return html;
  }

  // ---- PromptIQ Data Coach (ported) ----------------------------------------
  const DATA_CAPABILITIES = [
    {
      key: "relationships",
      name: "Data relationships",
      detect: /\b(join|joining|combine|combining|merge|merging|map(?:ping)?|relationship|relate|link|reconcile|cross[- ]?reference|match(?:ing)? records)\b/i,
      signals: [
        { key: "datasets", label: "the datasets/tables involved", why: "the model needs to know which sources it is relating before it can join them.", detect: /\b(table|tables|dataset|datasets|sheet|sheets|file|files|source|sources)\b/i },
        { key: "join keys", label: "the join key(s)", why: "without a shared key (e.g. UserId, email) the rows cannot be matched reliably.", detect: /\b(key|keys|id|ids|on\s+\w+|by\s+\w+|email|join key|primary key|foreign key)\b/i },
        { key: "grain", label: "the grain / level of detail", why: "mismatched grain causes fan-out and double counting.", detect: /\b(grain|granularity|per\s+\w+|one row per|row level|level of detail|aggregat)\b/i },
        { key: "relationship type", label: "the relationship type", why: "one-to-many vs many-to-many changes how the join behaves.", detect: /\b(one[- ]to[- ]one|one[- ]to[- ]many|many[- ]to[- ]many|1:1|1:n|n:n|inner|outer|left join|right join|full join)\b/i },
        { key: "business goal", label: "the business goal", why: "the join should serve a decision, not just stitch tables together.", detect: /\b(so that|in order to|to decide|to understand|because|goal|decision|recommend)\b/i },
        { key: "duplicate/unmatched handling", label: "how to handle duplicates & unmatched rows", why: "duplicates and orphaned rows silently distort the result.", detect: /\b(duplicat|dedup|unique|unmatch|orphan|no match|missing match|left over)\b/i },
      ],
    },
    {
      key: "excel",
      name: "Spreadsheet formulas",
      detect: /\b(excel|formula|formulas|spreadsheet|pivot|pivottable|vlookup|xlookup|sumif|countif|index match|power query|worksheet|cell|cells|google sheets)\b/i,
      signals: [
        { key: "desired calculation", label: "the exact calculation you want", why: "the model needs the math/logic, not just \"a formula\".", detect: /\b(sum|count|average|median|lookup|percentage|ratio|total|if|concatenate|round|rank|calculate)\b/i },
        { key: "cells/columns/ranges", label: "the cells, columns, or ranges", why: "a formula has to reference concrete locations.", detect: /\b([a-z]{1,3}\d{1,5}(?::[a-z]{1,3}\d{1,5})?)\b|\b(column|columns|cell|cells|range|ranges|row|rows)\b/i },
        { key: "conditions", label: "the conditions / criteria", why: "conditional logic depends on the exact rules to apply.", detect: /\b(if|when|where|only|exclude|include|greater than|less than|equals|matches|criteria|condition)\b/i },
        { key: "expected output", label: "the expected output", why: "a number, a column, a pivot, or a chart each need a different formula.", detect: /\b(return|result|output|expected|should\s+(?:show|return|be))\b/i },
        { key: "edge cases", label: "edge cases (blanks, errors, zeros)", why: "unhandled blanks or #N/A break the formula in real data.", detect: /\b(blank|empty|error|errors|#n\/a|na|zero|negative|missing|edge case)\b/i },
        { key: "version & form", label: "the app version and whether you want a formula, pivot, or query", why: "newer functions only exist in some versions, and the approach changes the answer.", detect: /\b(365|2019|2021|2016|online|desktop|google sheets|pivot|power query)\b/i },
      ],
    },
    {
      key: "retrieving",
      name: "Retrieving from datasources",
      detect: /\b(pull|pulling|retrieve|retrieving|query|querying|get|getting|extract|extracting|import|importing|fetch|fetching|download|from the (?:database|datasource|table|report|api|warehouse)|sql)\b/i,
      signals: [
        { key: "datasource name", label: "the datasource name", why: "the model can't query a source it can't identify.", detect: /\b(salesforce|postgres|mysql|sql server|snowflake|bigquery|redshift|databricks|s3|mongo|warehouse|database|datasource)\b/i },
        { key: "table/file/report/API", label: "the specific table, file, report, or API", why: "a datasource usually has many objects to choose from.", detect: /\b(table|file|report|api|view|endpoint|sheet|dataset)\b/i },
        { key: "fields", label: "the fields/columns to return", why: "selecting the right columns avoids huge, unusable pulls.", detect: /\b(field|fields|column|columns|attribute|select)\b/i },
        { key: "filters", label: "the filters", why: "filters scope the pull to the rows you actually need.", detect: /\b(filter|filters|where|only|for the|segment|region|exclude|include)\b/i },
        { key: "timeframe", label: "the timeframe", why: "without a date range the query may scan everything or nothing useful.", detect: /\b(?:last|past|previous|trailing)\s+\d+\s*(?:day|week|month|quarter|year)s?\b|\b(?:yesterday|today|ytd|mtd|qtd|q[1-4]|fy\d{2,4}|\d{4}|since|between)\b/i },
        { key: "freshness", label: "the data freshness needed", why: "live vs snapshot data changes which source/query is correct.", detect: /\b(latest|current|real[- ]?time|as of|fresh|updated|snapshot|live)\b/i },
        { key: "output format", label: "the output format", why: "a table, CSV, or chart each require different handling.", detect: /\b(table|csv|excel|chart|dashboard|json|list|summary|report)\b/i },
      ],
    },
    {
      key: "visualization",
      name: "Visualizations",
      detect: /\b(chart|charts|graph|graphs|dashboard|dashboards|visual|visualize|visualise|visualization|plot|bar chart|line chart|pie chart|trend|trends|slide|slides|deck)\b/i,
      signals: [
        { key: "metric", label: "the metric to plot", why: "a chart needs a quantity on its value axis.", detect: /\b(revenue|sales|conversion|retention|churn|users?|orders?|count|sum|average|rate|growth|kpi|metric|margin|nps|dau|mau)\b/i },
        { key: "dimension", label: "the dimension to break it down by", why: "the category/axis determines what the chart compares.", detect: /\b(by\s+\w+|per\s+\w+|segment|category|region|product|channel|dimension|group by)\b/i },
        { key: "timeframe", label: "the timeframe", why: "trends and comparisons need a defined period.", detect: /\b(?:last|past|previous|trailing)\s+\d+\s*(?:day|week|month|quarter|year)s?\b|\b(?:ytd|mtd|qtd|q[1-4]|fy\d{2,4}|\d{4}|over time|trend)\b/i },
        { key: "chart type", label: "the chart type", why: "bar vs line vs pie communicate very different things.", detect: /\b(bar|line|pie|scatter|column|area|heatmap|histogram|donut|funnel|chart type)\b/i },
        { key: "audience", label: "the audience", why: "an exec summary and an analyst view need different detail.", detect: /\b(audience|executive|exec|leadership|stakeholder|team|board|customer|analyst)\b/i },
        { key: "takeaway", label: "the key takeaway", why: "the visual should make one point obvious.", detect: /\b(takeaway|insight|message|story|highlight|key point|so that|show that)\b/i },
        { key: "output format", label: "the output format", why: "a slide, spreadsheet, or image each change how it's built.", detect: /\b(slide|deck|excel|dashboard|png|image|report|pdf)\b/i },
      ],
    },
    {
      key: "knowledge",
      name: "Datasource knowledge",
      detect: /\b(which (?:datasource|dataset|table|source)|where (?:is|does|do)\b.*\bdata|what (?:fields|columns|data)|metric definition|where does .* live|appropriate (?:dataset|source|datasource)|best (?:dataset|source|datasource)|how is .* (?:defined|measured|calculated))\b/i,
      signals: [
        { key: "business question", label: "the business question", why: "the right source depends on what you're trying to answer.", detect: /\b(why|what|how many|which|understand|so that|in order to|to decide|to answer)\b/i },
        { key: "known source", label: "any source you already know of", why: "narrows the search and avoids re-deriving known data.", detect: /\b(salesforce|postgres|mysql|sql|snowflake|bigquery|table|report|dataset|warehouse|i\s+(?:use|have))\b/i },
        { key: "metric definition", label: "how the metric is defined", why: "the same word (e.g. \"active user\") differs across sources.", detect: /\b(defined|definition|means|measured|calculated as|counts?\s+as)\b/i },
        { key: "data quality risks", label: "data quality concerns", why: "an authoritative source matters more than a convenient one.", detect: /\b(quality|accurate|reliable|trust|authoritative|complete|stale|gold)\b/i },
        { key: "recommendation need", label: "whether you want a recommendation", why: "asking for a recommendation (vs a list) changes the answer.", detect: /\b(recommend|suggest|best|appropriate|should i\s+(?:use|pick)|which.*better)\b/i },
        { key: "desired output", label: "the desired output", why: "a shortlist, a definition, or a query each need a different reply.", detect: /\b(list|shortlist|definition|query|table|summary|recommendation)\b/i },
      ],
    },
  ];

  const DATA_GENERAL = {
    key: "general",
    name: "General data analysis",
    signals: [
      { key: "metric", label: "the metric or question", why: "\"analyze\" is open-ended; the model needs to know what to measure.", detect: /\b(revenue|sales|conversion|retention|churn|users?|orders?|count|rate|growth|kpi|metric|margin|nps|trend|driver|why)\b/i },
      { key: "dataset", label: "the specific dataset/source", why: "\"this data\" tells the model nothing about what evidence to use.", detect: /\b(csv|excel|xlsx|sheet|table|dataset|database|sql|query|file|report|dashboard|attached|api)\b/i },
      { key: "timeframe", label: "the timeframe", why: "almost every data question is bounded by a time window.", detect: /\b(?:last|past|previous|trailing)\s+\d+\s*(?:day|week|month|quarter|year)s?\b|\b(?:ytd|mtd|qtd|q[1-4]|fy\d{2,4}|\d{4}|yesterday|today|since|between)\b/i },
      { key: "comparison baseline", label: "the comparison baseline", why: "a number only has meaning relative to a target or prior period.", detect: /\b(compare|comparison|versus|vs\.?|baseline|benchmark|prior|previous period|target|goal|yoy|wow|mom|year-over-year|week-over-week|change|delta)\b/i },
      { key: "decision/output", label: "the decision or output you need", why: "knowing the decision lets the model shape an actionable answer.", detect: /\b(decide|decision|recommend|action|next step|so that|in order to|root cause|identify|figure out|summari[sz]e|output|report)\b/i },
    ],
  };

  function classifyDataPrompt(input) {
    let best = null, bestCount = 0;
    for (const cap of DATA_CAPABILITIES) {
      const matches = input.match(new RegExp(cap.detect.source, "gi"));
      const count = matches ? matches.length : 0;
      if (count > bestCount) { bestCount = count; best = cap; }
    }
    return best || DATA_GENERAL;
  }

  function dataCoachAnalyze(rawInput) {
    const input = (rawInput || "").trim();
    const capability = classifyDataPrompt(input);
    const signals = capability.signals;
    const present = [], missing = [];
    for (const s of signals) { (s.detect.test(input) ? present : missing).push(s); }

    const ratio = signals.length ? present.length / signals.length : 0;
    let score = Math.round(ratio * 100);
    if (input) score = Math.max(score, 15);
    score = Math.min(score, 98);

    const label = score >= 80 ? "Strong" : score >= 60 ? "Good — minor gaps" : score >= 40 ? "Needs work" : "Too vague";
    const missingLabels = missing.map((m) => m.label);
    const firstMissing = missing[0];
    function tipFor(extra) {
      const head = missingLabels.length ? `Add ${missingLabels.slice(0, 3).join(", ")}.` : "";
      return `${head} ${extra || ""}`.trim();
    }

    const suggestions = [];
    const directByCap = { relationships: "Join", excel: "Write a formula to calculate", retrieving: "Pull", visualization: "Create a chart of", knowledge: "Recommend the best datasource to answer", general: "Analyze [metric] trends in" };
    const verbByCap = { relationships: "Join", excel: "Write a formula to", retrieving: "Pull", visualization: "Build a chart of", knowledge: "Recommend the best datasource to", general: "Analyze" };
    const leadVerb = input.match(/^(?:can|could)\s+you\s+(?:please\s+)?(?:analy[sz]e|look at|review|pull|get|build|create|make|show|find|combine|join|visuali[sz]e|chart)\b/i);
    if (leadVerb) {
      suggestions.push({ term: leadVerb[0], tip: "Lead with a specific action verb instead of asking permission, and name what to analyze.", rewrite: directByCap[capability.key] || "Analyze" });
    } else if (/^(?:can|could)\s+you\b/i.test(input)) {
      suggestions.push({ term: input.match(/^(?:can|could)\s+you/i)[0], tip: "Lead with the action instead of asking permission, so the model knows the exact task.", rewrite: verbByCap[capability.key] || "Analyze" });
    } else {
      const vagueVerb = input.match(/\banaly[sz]e\b|\blook at\b|\breview\b/i);
      if (vagueVerb) {
        suggestions.push({ term: vagueVerb[0], tip: "Name a specific analysis lens (trend, variance, anomaly, or segment-driver).", rewrite: "analyze [metric] trends in" });
      }
    }
    const vagueData = input.match(/\bthis data\b|\bthe data\b|\bthese\b|\bthe report\b|\bthe file\b|\bthe dataset\b/i);
    if (vagueData) {
      suggestions.push({ term: vagueData[0], tip: tipFor("Name the dataset/source, timeframe, and metric so the model knows what evidence to use."), rewrite: "[dataset name] for [timeframe]" });
    }
    if (!suggestions.length && firstMissing) {
      const anyTerm = input.match(/\bdata\b|\bchart\b|\bformula\b|\breport\b|\bdashboard\b|\bnumbers?\b|\bpivot\b/i);
      if (anyTerm) {
        suggestions.push({ term: anyTerm[0], tip: tipFor(firstMissing.why), rewrite: `[${firstMissing.label.replace(/^the\s+/i, "")}]` });
      }
    }

    const improvedByCap = {
      relationships: "Join [dataset A] and [dataset B] on [join key] at [grain]. It is a [one-to-many/many-to-many] relationship; flag duplicates and unmatched rows. Goal: [decision]. Return a [table/summary].",
      excel: "Write a [formula/pivot/query] that calculates [calculation] for [columns/range], applying [conditions]. Handle [blanks/errors] and return [expected output].",
      retrieving: "Pull [fields] from [datasource → table/report] for [timeframe], filtered to [filters], using [latest/snapshot] data. Return as [table/CSV/chart].",
      visualization: "Create a [chart type] of [metric] by [dimension] over [timeframe] for [audience], highlighting [key takeaway]. Output as [slide/spreadsheet].",
      knowledge: "I need to answer [business question]. Recommend the best datasource and fields, note how [metric] is defined and any data-quality risks. I currently know of [known source]. Return a short recommendation.",
      general: "Analyze [metric] in [dataset/source] over [timeframe], compared to [baseline/prior period]. Identify the top drivers and segments, and summarize recommended actions for [decision]. Return results as a [table/chart].",
    };
    const improvedPrompt = improvedByCap[capability.key] || improvedByCap.general;
    const clarifying = missing.slice(0, 3).map((m) => `What is ${m.label.replace(/^the\s+/i, "")}?`);

    return {
      classification: capability.name, score, label,
      present: present.map((s) => s.label),
      missing: missing.map((s) => ({ label: s.label, why: s.why })),
      suggestions, improvedPrompt, clarifying,
    };
  }

  function renderCoachCard(coach) {
    const tone = coach.score >= 60 ? "good" : coach.score >= 40 ? "mid" : "low";
    const missingHtml = coach.missing.length
      ? `<ul class="pc-coach-list">${coach.missing.map((m) => `<li><strong>${escapeHtml(m.label)}</strong> — ${escapeHtml(m.why)}</li>`).join("")}</ul>`
      : `<div class="pc-coach-ok">Nothing critical missing — this is a strong data prompt.</div>`;
    const clarifyingHtml = coach.clarifying && coach.clarifying.length
      ? `<div class="pc-coach-section"><div class="pc-coach-h">Optional clarifying questions</div><ul class="pc-coach-list">${coach.clarifying.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></div>`
      : "";
    return `
      <div class="pc-coach">
        <div class="pc-coach-row">
          <span class="pc-coach-tag">PromptIQ Data Coach</span>
          <span class="pc-coach-class">${escapeHtml(coach.classification)}</span>
          <span class="pc-coach-badge pc-coach-${tone}">${escapeHtml(coach.label)}</span>
        </div>
        <div class="pc-coach-section"><div class="pc-coach-h">What's missing &amp; why it matters</div>${missingHtml}</div>
        <div class="pc-coach-section"><div class="pc-coach-h">Suggested improved prompt</div><div class="pc-coach-improved">${escapeHtml(coach.improvedPrompt)}</div></div>
        ${clarifyingHtml}
        <div class="pc-coach-hint">Click an underlined word above for a targeted fix, or press <strong>Use improved prompt</strong> to apply the full rewrite.</div>
      </div>`;
  }

  // ---- top-level analysis (ported) -----------------------------------------
  function analyzePrompt(text) {
    const input = (text || "").trim();
    if (!input) {
      return { score: 0, issue: "Begin typing to get prompt insights.", highlight: "", suggestions: [], rewrite: "" };
    }
    let score = 92, issue = "", highlight = "", suggestions = [], rewrite = input;

    const looksLikeCodeReview = /\bbugs?\b/i.test(input) || /\bcode\b/i.test(input);
    const looksLikeDataAnalysis = /\bdata\b/i.test(input) || /\banaly[sz]e\b/i.test(input) || /\bCSV\b/i.test(input) || /\bmetrics?\b/i.test(input);
    const looksLikeMarketing = /\bcampaign\b/i.test(input) || /\bfeedback\b/i.test(input) || /\bsentiment\b/i.test(input) || /\bmarketing\b/i.test(input);

    if (activeUseCase === "data" || (!looksLikeCodeReview && looksLikeDataAnalysis)) {
      const coach = dataCoachAnalyze(input);
      const missingSummary = coach.missing.length
        ? ` — missing ${coach.missing.slice(0, 3).map((m) => m.label.replace(/^the\s+/i, "")).join(", ")}`
        : " — strong prompt";
      return {
        score: coach.score,
        issue: `${coach.classification} · ${coach.label}${missingSummary}`,
        highlight: coach.suggestions.map((s) => s.term).join(", "),
        suggestions: coach.suggestions, rewrite: coach.improvedPrompt, coach,
      };
    } else if (activeUseCase === "marketing" || looksLikeMarketing) {
      const lead = input.match(/^(?:can|could)\s+you\s+(?:help me\s+)?(?:analy[sz]e|review|look at|check|assess)\b/i);
      if (lead) {
        suggestions.push({ term: lead[0], tip: "Lead with a concrete action like 'Classify sentiment in' instead of asking permission.", rewrite: "Classify sentiment in" });
      } else if (/^(?:can|could)\s+you\b/i.test(input)) {
        suggestions.push({ term: input.match(/^(?:can|could)\s+you/i)[0], tip: "Lead with the action verb instead of asking permission.", rewrite: "Classify sentiment in" });
      }
      const fb = input.match(/\b(?:this |the |these )?campaign feedback\b|\b(?:this |the |these )?(?:customer )?comments\b|\b(?:this |the |these )?feedback\b/i);
      if (fb) suggestions.push({ term: fb[0], tip: "Say what to break the feedback down by — audience segment, channel, and sentiment category.", rewrite: "the campaign feedback by audience segment, channel, and sentiment category" });
      score = suggestions.length >= 2 ? 40 : suggestions.length === 1 ? 70 : 92;
      issue = suggestions.length > 0 ? "Add audience, channel, sentiment categories, and the marketing decision you need." : "Strong marketing sentiment prompt.";
      highlight = suggestions.map((item) => item.term).join(", ");
      rewrite = "Classify sentiment in the campaign feedback by audience segment, channel, and sentiment category. Identify top positive themes, objections, purchase-intent signals, and recommended messaging changes.";
    } else if (looksLikeCodeReview) {
      const lead = input.match(/^(?:can|could)\s+you\s+(?:please\s+)?(?:find|review|check|analy[sz]e|look at|debug|fix)\b/i);
      if (lead) {
        suggestions.push({ term: lead[0], tip: "Lead with a precise review action instead of asking permission, so the model knows exactly what to do.", rewrite: "Review" });
      } else if (/^(?:can|could)\s+you\b/i.test(input)) {
        suggestions.push({ term: input.match(/^(?:can|could)\s+you/i)[0], tip: "Lead with the action verb instead of asking permission.", rewrite: "Review" });
      }
      const bug = input.match(/\bbugs?\b/i);
      if (bug) suggestions.push({ term: bug[0], tip: "Name a specific review focus instead of the broad word 'bugs' — e.g. logic errors, edge cases, security issues, and async/state bugs.", rewrite: "logic errors, edge cases, security issues, and async/state bugs" });
      const codeTarget = input.match(/\bmy code\b|\bthe code\b|\bcode\b/i);
      if (codeTarget) suggestions.push({ term: codeTarget[0], tip: "Point at a concrete code target so the model knows what to inspect — e.g. the attached TypeScript React checkout component.", rewrite: "the attached TypeScript React checkout component" });
      score = suggestions.length >= 3 ? 31 : suggestions.length === 2 ? 52 : suggestions.length === 1 ? 74 : 92;
      issue = suggestions.length > 0
        ? "Tighten one underlined phrase at a time — PromptIQ keeps flagging what still needs work."
        : "Strong code review prompt. You have a clear action, bug class, and target code.";
      highlight = suggestions.map((item) => item.term).join(", ");
      rewrite = "Review the attached TypeScript React checkout component for logic errors, edge cases, security issues, and async/state bugs. Flag each issue by severity, explain why it is a bug, and provide the exact code change needed.";
    } else {
      if (!/(react|typescript|javascript|python|java|c#|go|node|vue|angular)/i.test(input)) { score -= 18; issue = "Add technology stack for faster, more accurate help."; }
      if (!/(error|exception|fails|undefined|null|stack trace|cannot)/i.test(input)) { score -= 18; issue = issue || "Include the exact error message."; }
      if (!/(expected|should|want|goal)/i.test(input)) { score -= 12; issue = issue || "State expected behavior."; }
      if (!/(file|function|component|line|snippet|code)/i.test(input)) { score -= 10; issue = issue || "Reference where in code the issue occurs."; }
      score = Math.max(18, Math.min(98, score));
    }
    return { score, issue, highlight, suggestions, rewrite };
  }

  // ---- UI rendering ---------------------------------------------------------
  function renderNav() {
    const nav = document.getElementById("nav");
    nav.innerHTML = Object.entries(USE_CASES).map(([key, uc]) =>
      `<button type="button" class="nav-item ${key === activeUseCase ? "is-active" : ""}" data-key="${key}">
        <span class="nav-dot"></span><span>${escapeHtml(uc.file)}</span>
      </button>`
    ).join("");
    nav.querySelectorAll(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeUseCase = btn.getAttribute("data-key");
        renderAll();
        const input = document.getElementById("prompt-input");
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
  }

  function renderChat() {
    const uc = USE_CASES[activeUseCase];
    document.getElementById("scenario-title").textContent = uc.label;
    const chat = document.getElementById("chat");
    chat.innerHTML = uc.messages.map((m) => {
      if (m.kind === "tool") {
        return `<div class="piq-tool-row"><b>●</b> ${escapeHtml(m.text)}</div>`;
      }
      const roleLabel = m.kind === "user" ? "You" : "Assistant";
      const body = m.html ? m.html : escapeHtml(m.text).replace(/\n/g, "<br>");
      return `<div class="msg msg-${m.kind}">
        <div class="msg-role">${roleLabel}</div>
        <div class="bubble">${body}</div>
      </div>`;
    }).join("");
    chat.scrollTop = chat.scrollHeight;
  }

  function mountCoach() {
    const form = document.getElementById("composer");
    const input = document.getElementById("prompt-input");

    const row = document.createElement("div");
    row.id = "prompt-coach-row";
    row.className = "pc-row";
    row.innerHTML = `
      <div class="pc-toggle-wrap">
        <button type="button" class="pc-toggle" aria-pressed="true" title="PromptIQ toggle"><span class="pc-toggle-dot"></span></button>
        <span class="pc-mark">✨</span>
        <span class="pc-label">PromptIQ</span>
      </div>
      <div class="pc-actions">
        <span class="pc-score">—</span>
        <button type="button" class="pc-ghost-btn pc-example-btn" title="Insert a sample prompt to coach">Try an example</button>
        <button type="button" class="pc-rewrite-btn" title="Replace your prompt with the improved version">Apply improvement</button>
      </div>
      <div class="pc-tip">Begin typing, or try an example prompt.</div>
      <div class="pc-highlight" hidden></div>`;
    form.insertBefore(row, form.firstChild);

    const toggle = row.querySelector(".pc-toggle");
    const scoreEl = row.querySelector(".pc-score");
    const tipEl = row.querySelector(".pc-tip");
    const highlightEl = row.querySelector(".pc-highlight");
    const rewriteBtn = row.querySelector(".pc-rewrite-btn");
    const exampleBtn = row.querySelector(".pc-example-btn");

    let enabled = true, selectedTerm = "", current = analyzePrompt(input.value);
    const inlineOverlay = document.createElement("div");
    inlineOverlay.className = "pc-input-overlay";
    document.body.appendChild(inlineOverlay);

    function setInputValue(value) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    }
    function positionInlineOverlay() {
      const r = input.getBoundingClientRect();
      const c = window.getComputedStyle(input);
      Object.assign(inlineOverlay.style, {
        left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
        font: c.font, letterSpacing: c.letterSpacing, paddingLeft: c.paddingLeft, paddingRight: c.paddingRight,
        paddingTop: c.paddingTop, paddingBottom: c.paddingBottom, lineHeight: c.lineHeight,
      });
    }
    function render() {
      const hasText = input.value.trim().length > 0;
      if (!enabled) {
        row.classList.add("pc-disabled");
        scoreEl.textContent = "—"; scoreEl.className = "pc-score"; tipEl.style.display = "none";
        highlightEl.hidden = true; highlightEl.innerHTML = "";
        rewriteBtn.textContent = "Apply improvement";
        inlineOverlay.hidden = true; inlineOverlay.innerHTML = ""; rewriteBtn.disabled = true; return;
      }
      if (!hasText) {
        selectedTerm = ""; row.classList.remove("pc-disabled");
        scoreEl.textContent = "—"; scoreEl.className = "pc-score"; tipEl.style.display = "block";
        tipEl.textContent = "Begin typing, or try an example prompt.";
        highlightEl.hidden = true; highlightEl.innerHTML = "";
        rewriteBtn.textContent = "Apply improvement";
        inlineOverlay.hidden = true; inlineOverlay.innerHTML = ""; rewriteBtn.disabled = true; return;
      }
      row.classList.remove("pc-disabled");
      const sc = Math.round(current.score);
      scoreEl.textContent = `${sc}/100`;
      scoreEl.className = "pc-score " + (sc >= 70 ? "pc-score-good" : sc >= 45 ? "pc-score-mid" : "pc-score-low");
      tipEl.style.display = "block";
      tipEl.textContent = current.issue || "Strong prompt. You can still add constraints or success criteria.";
      inlineOverlay.hidden = !(current.suggestions && current.suggestions.length);
      if (!inlineOverlay.hidden) {
        positionInlineOverlay();
        inlineOverlay.innerHTML = renderInlineUnderlines(input.value, current.suggestions, selectedTerm);
      }
      const selectedSuggestion = (current.suggestions || []).find((item) => item.term === selectedTerm);
      if (selectedSuggestion) {
        highlightEl.hidden = false;
        highlightEl.innerHTML = `
          <div class="pc-selected-suggestion">
            <div class="pc-suggestion-item is-focused">
              <mark>${escapeHtml(selectedSuggestion.term)}</mark>
              <span>${escapeHtml(selectedSuggestion.tip)}</span>
            </div>
            <div class="pc-rewrite-preview">Recommended change: <strong>${escapeHtml(selectedSuggestion.term)}</strong> → <strong>${escapeHtml(selectedSuggestion.rewrite || selectedSuggestion.term)}</strong></div>
          </div>`;
        rewriteBtn.textContent = "Apply this fix";
        rewriteBtn.disabled = false;
      } else if (current.coach) {
        highlightEl.hidden = false;
        highlightEl.innerHTML = renderCoachCard(current.coach);
        rewriteBtn.textContent = "Use improved prompt";
        rewriteBtn.disabled = false;
      } else if (current.suggestions && current.suggestions.length) {
        highlightEl.hidden = false;
        highlightEl.innerHTML = `<div class="pc-coach-section"><div class="pc-coach-h">Suggested improved prompt</div><div class="pc-coach-improved">${escapeHtml(current.rewrite || "")}</div></div><div class="pc-coach-hint">Click an underlined word for a one-phrase fix, or press <strong>Use improved prompt</strong> for the full rewrite.</div>`;
        rewriteBtn.textContent = "Use improved prompt";
        rewriteBtn.disabled = !(current.rewrite && current.rewrite.trim());
      } else {
        highlightEl.hidden = true; inlineOverlay.hidden = true;
        rewriteBtn.textContent = "Apply improvement"; rewriteBtn.disabled = true;
      }
    }
    function refresh() {
      current = analyzePrompt(input.value);
      if (selectedTerm && !(current.suggestions || []).some((item) => item.term === selectedTerm)) selectedTerm = "";
      render();
    }

    inlineOverlay.addEventListener("click", (e) => {
      e.stopPropagation();
      const token = e.target.closest("[data-term]");
      if (!token) return;
      selectedTerm = token.getAttribute("data-term") || "";
      render();
    });
    document.addEventListener("click", (e) => {
      if (!row.contains(e.target) && !inlineOverlay.contains(e.target)) { selectedTerm = ""; render(); }
    });
    toggle.addEventListener("click", () => {
      enabled = !enabled; toggle.setAttribute("aria-pressed", String(enabled)); render();
    });
    rewriteBtn.addEventListener("click", () => {
      if (!enabled) return;
      const selected = (current.suggestions || []).find((item) => item.term === selectedTerm);
      if (selected) { setInputValue(applySuggestion(input.value, selected)); selectedTerm = ""; refresh(); return; }
      if (current.coach && current.coach.improvedPrompt) { setInputValue(current.coach.improvedPrompt); selectedTerm = ""; refresh(); }
      else if (current.rewrite) { setInputValue(current.rewrite); selectedTerm = ""; refresh(); }
    });
    exampleBtn.addEventListener("click", () => {
      setInputValue((USE_CASES[activeUseCase] || USE_CASES.code).example);
      refresh();
    });

    input.addEventListener("input", refresh);
    input.addEventListener("scroll", positionInlineOverlay);
    window.addEventListener("resize", positionInlineOverlay);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const chat = document.getElementById("chat");
      const msg = document.createElement("div");
      msg.className = "msg msg-user";
      msg.innerHTML = `<div class="msg-role">You</div><div class="bubble">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
      chat.appendChild(msg);
      chat.scrollTop = chat.scrollHeight;
      input.value = "";
      refresh();
    });

    refresh();
  }

  function renderAll() {
    renderNav();
    renderChat();
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderAll();
    mountCoach();
  });
})();

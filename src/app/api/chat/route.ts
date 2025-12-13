import { streamText, convertToModelMessages } from "ai";
import { healthcareTools } from "@/lib/tools";
import { BiomedUIMessage } from "@/lib/types";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { getModelProvider, getModelConfig, getProviderOptions, selectModel, ModelSelectionContext } from '@/lib/model-config';
import { checkAnonymousRateLimit, incrementRateLimit } from "@/lib/rate-limit";
import { createClient } from '@supabase/supabase-js';
import { checkUserRateLimit } from '@/lib/rate-limit';
import { validateAccess } from '@/lib/polar-access-validation';
import { getPolarTrackedModel } from '@/lib/polar-llm-strategy';
import * as db from '@/lib/db';
import { isDevelopmentMode } from '@/lib/local-db/local-auth';
import { saveChatMessages } from '@/lib/db';
import { fa } from "zod/v4/locales";

// 13mins max streaming (vercel limit)
export const maxDuration = 800;

export async function POST(req: Request) {
  try {
    const { messages, sessionId }: { messages: BiomedUIMessage[], sessionId?: string } = await req.json();
    console.log("[Chat API] ========== NEW REQUEST ==========");
    console.log("[Chat API] Received sessionId:", sessionId);
    console.log("[Chat API] Number of messages:", messages.length);
    // console.log(
    //   "[Chat API] Incoming messages:",
    //   JSON.stringify(messages, null, 2)
    // );

    // Determine if this is a user-initiated message (should count towards rate limit)
    // ONLY increment for the very first user message in a conversation
    // All tool calls, continuations, and follow-ups should NOT increment
    const lastMessage = messages[messages.length - 1];
    const isUserMessage = lastMessage?.role === 'user';
    const userMessageCount = messages.filter(m => m.role === 'user').length;
    
    // Simple rule: Only increment if this is a user message AND it's the first user message
    const isUserInitiated = isUserMessage && userMessageCount === 1;
    
    console.log("[Chat API] Rate limit check:", {
      isUserMessage,
      userMessageCount,
      isUserInitiated,
      totalMessages: messages.length
    });

    // Check app mode and configure accordingly
    const isDevelopment = isDevelopmentMode();
    console.log("[Chat API] App mode:", isDevelopment ? 'development' : 'production');

    // Get authenticated user (uses local auth in dev mode)
    const { data: { user } } = await db.getUser();
    console.log("[Chat API] Authenticated user:", user?.id || 'anonymous');

    // Legacy Supabase clients (only used in production mode)
    let supabaseAnon: any = null;
    let supabase: any = null;

    if (!isDevelopment) {
      supabaseAnon = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          global: {
            headers: {
              Authorization: req.headers.get('Authorization') || '',
            },
          },
        }
      );

      supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      );
    }

    // Validate access for authenticated users (simplified validation)
    if (user && !isDevelopment) {
      const accessValidation = await validateAccess(user.id);
      
      if (!accessValidation.hasAccess && accessValidation.requiresPaymentSetup) {
        console.log("[Chat API] Access validation failed - payment required");
        return new Response(
          JSON.stringify({
            error: "PAYMENT_REQUIRED",
            message: "Payment method setup required",
            tier: accessValidation.tier,
            action: "setup_payment"
          }),
          { status: 402, headers: { 'Content-Type': 'application/json' } }
        );
      }
      
      if (accessValidation.hasAccess) {
        console.log("[Chat API] Access validated for tier:", accessValidation.tier);
      }
    }

    // Check rate limit for user-initiated messages
    if (isUserInitiated && !isDevelopment) {
      if (!user) {
        // Fall back to anonymous rate limiting for non-authenticated users
        const rateLimitStatus = await checkAnonymousRateLimit();
        console.log("[Chat API] Anonymous rate limit status:", rateLimitStatus);
        
        if (!rateLimitStatus.allowed) {
          console.log("[Chat API] Anonymous rate limit exceeded");
          return new Response(
            JSON.stringify({
              error: "RATE_LIMIT_EXCEEDED",
              message: "You have exceeded your daily limit of 5 queries. Sign up to continue.",
              resetTime: rateLimitStatus.resetTime.toISOString(),
              remaining: rateLimitStatus.remaining,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "X-RateLimit-Limit": rateLimitStatus.limit.toString(),
                "X-RateLimit-Remaining": rateLimitStatus.remaining.toString(),
                "X-RateLimit-Reset": rateLimitStatus.resetTime.toISOString(),
              },
            }
          );
        }
      } else {
        // Check user-based rate limits
        const rateLimitResult = await checkUserRateLimit(user.id);
        console.log("[Chat API] User rate limit status:", rateLimitResult);
        
        if (!rateLimitResult.allowed) {
          return new Response(JSON.stringify({
            error: "RATE_LIMIT_EXCEEDED",
            message: "Daily query limit reached. Upgrade to continue.",
            resetTime: rateLimitResult.resetTime.toISOString(),
            tier: rateLimitResult.tier
          }), {
            status: 429,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
    } else if (isUserInitiated && isDevelopment) {
      console.log("[Chat API] Development mode: Rate limiting disabled");
    }

    // Get model configuration based on MODEL_PROVIDER environment variable
    const modelConfig = getModelConfig();
    const provider = modelConfig.provider;

    // Determine user tier for model selection
    let userTier: 'free' | 'pay_per_use' | 'unlimited' = 'free';
    if (user) {
      const { data: userData } = await db.getUserProfile(user.id);
      userTier = (userData?.subscription_tier || userData?.subscriptionTier || 'free') as 'free' | 'pay_per_use' | 'unlimited';
      console.log("[Chat API] User tier:", userTier);
    }

    // Build context for intelligent model selection
    const modelContext: ModelSelectionContext = {
      userId: user?.id,
      userTier,
      feature: 'chat',
      isDevelopment,
    };

    // Select model using intelligent routing
    const primarySelection = selectModel(modelConfig.primaryModel, modelContext);

    console.log("[Chat API] Model selected:", primarySelection.description);

    const selectedModel = primarySelection.model;
    const modelInfo = primarySelection.description;

    // Get provider options with gateway config if applicable
    const providerOptions = getProviderOptions(provider, {
      userId: user?.id,
      userTier,
      feature: 'chat',
      usesGateway: primarySelection.usesGateway,
      tags: primarySelection.tags,
    });

    // Track processing start time
    const processingStartTime = Date.now();

    // Note: We don't save individual messages here anymore.
    // The entire conversation is saved in onFinish callback after streaming completes.
    // This follows the Vercel AI SDK v5 recommended pattern.

    console.log(`[Chat API] About to call streamText with model:`, selectedModel);
    console.log(`[Chat API] Model info:`, modelInfo);

    // Save user message immediately (before streaming starts)
    if (user && sessionId && messages.length > 0) {
      console.log('[Chat API] Saving user message immediately before streaming');
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.role === 'user') {
        const { randomUUID } = await import('crypto');
        const userMessageToSave = {
          id: randomUUID(), // Generate proper UUID instead of using AI SDK's short ID
          role: 'user' as const,
          content: lastMessage.parts || [],
        };

        // Get existing messages first
        const { data: existingMessages } = await db.getChatMessages(sessionId);
        const allMessages = [...(existingMessages || []), userMessageToSave];

        await saveChatMessages(sessionId, allMessages.map((msg: any) => ({
          id: msg.id,
          role: msg.role,
          content: typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content,
        })));

        // Update session timestamp
        await db.updateChatSession(sessionId, user.id, {
          last_message_at: new Date()
        });
        console.log('[Chat API] User message saved');
      }
    }

    // Extract system prompt to constant for caching
    const SYSTEM_PROMPT = `You are a helpful biomedical research assistant with access to comprehensive tools for Python code execution, biomedical data, clinical trials, drug information, scientific literature, web search, and data visualization.

      CRITICAL CITATION INSTRUCTIONS:
      When you use ANY search tool (clinical trials, drug information, biomedical literature, or web search) and reference information from the results in your response:

      1. **Citation Format**: Use square brackets [1], [2], [3], etc.
      2. **Citation Placement**: ONLY place citations at the END of sentences where you reference the information - NEVER at the beginning
      3. **Multiple Citations**: When multiple sources support the same statement, group them together: [1][2][3] or [1,2,3]
      4. **Sequential Numbering**: Number citations sequentially starting from [1] based on the order sources appear in your search results
      5. **Consistent References**: The same source always gets the same number throughout your response

      CITATION PLACEMENT RULES (CRITICAL - READ CAREFULLY):
      - ✅ CORRECT: Place citations ONLY at the END of sentences before the period: "Tesla's revenue grew 50% in Q3 2023 [1]."
      - ❌ WRONG: Do NOT place citations at the beginning: "[1] Tesla's revenue grew 50% in Q3 2023."
      - ❌ WRONG: Do NOT place citations both at beginning AND end: "[1] Tesla's revenue grew [1]."
      - ✅ CORRECT: For multiple facts from the same source, cite once at the end of each sentence or once at paragraph end
      - ✅ CORRECT: Group multiple citations together: "Multiple studies confirm significant efficacy [1][2][3]."
      - For bullet points in lists, place citations at the end of each bullet point if needed

      Example of PROPER citation usage:
      "Pembrolizumab demonstrated an overall response rate of 45% in NSCLC patients with PD-L1 expression >50% [1]. Median progression-free survival reached 10.3 months, exceeding historical controls [1][2]. Grade 3-4 immune-related adverse events occurred in 17% of patients [3]. These results demonstrate pembrolizumab's strong efficacy profile across multiple endpoints [1][2][3]."

      Example of WRONG citation usage (DO NOT DO THIS):
      "[1] Pembrolizumab demonstrated an ORR of 45% [1]. [2] The median PFS reached 10.3 months [2]."

      You can:

         - Execute Python code for pharmacokinetic modeling, statistical analysis, data visualization, and complex calculations using the codeExecution tool (runs in a secure Daytona Sandbox)
         - The Python environment can install packages via pip at runtime inside the sandbox (e.g., numpy, pandas, scipy, scikit-learn, biopython)
         - Visualization libraries (matplotlib, seaborn, plotly) may work inside Daytona. However, by default, prefer the built-in chart creation tool for standard time series and comparisons. Use Daytona for advanced or custom visualizations only when necessary.
         - Search for clinical trials data using the clinical trials search tool (ClinicalTrials.gov data, trial phases, endpoints, patient populations)
         - Search FDA drug labels using the drug information search tool (DailyMed data, contraindications, dosing, interactions, warnings)
         - Search biomedical literature using the biomedical literature search tool (PubMed articles, ArXiv papers, peer-reviewed research)
         - Search the web for general information using the web search tool (any topic with relevance scoring and cost control)
         - Create interactive charts and visualizations using the chart creation tool:
           • Line charts: Time series trends (survival curves, drug concentrations over time)
           • Bar charts: Categorical comparisons (response rates, adverse event frequencies)
           • Area charts: Cumulative data (patient enrollment, event-free survival)
           • Scatter/Bubble charts: Correlation analysis, biomarker expression, dose-response relationships
           • Quadrant charts: 2x2 clinical matrices (efficacy vs safety, risk-benefit analysis)

      **CRITICAL NOTE**: You must only make max 5 parallel tool calls at a time.

      **CRITICAL INSTRUCTIONS**: Your reports must be incredibly thorough and detailed, explore everything that is relevant to the user's query that will help to provide
      the perfect response that is of a level expected of an elite level senior biomedical researcher at a leading pharmaceutical research institution.

      For clinical trials searches, you can access:
      • Trial registration data from ClinicalTrials.gov
      • Phase I, II, III, and IV study information
      • Primary and secondary endpoints
      • Patient inclusion/exclusion criteria
      • Study sponsors and principal investigators
      • Results and outcome measures

      For drug information searches, you can access:
      • FDA-approved drug labels from DailyMed
      • Indications and usage
      • Dosage and administration
      • Contraindications and warnings
      • Drug interactions and adverse reactions
      • Pharmacokinetics and pharmacodynamics

      For biomedical literature searches, you can access:
      • PubMed indexed journal articles
      • ArXiv preprints in quantitative biology and bioinformatics
      • Peer-reviewed research papers
      • Clinical study results and meta-analyses
      • Mechanism of action studies
      • Preclinical and translational research

               For web searches, you can find information on:
         • Current events and news from any topic
         • Research topics with high relevance scoring
         • Educational content and explanations
         • Technology trends and developments
         • General knowledge across all domains

         For data visualization, you can create charts when users want to:
         • Compare multiple drugs, treatments, or clinical outcomes (line/bar charts)
         • Visualize trends over time (line/area charts for survival curves, drug concentrations)
         • Display patient response rates or adverse event frequencies (bar charts)
         • Show relationships between biomarkers and outcomes (scatter charts for correlation)
         • Map efficacy vs safety positioning (scatter charts for drug comparison)
         • Create 2x2 clinical matrices (quadrant charts for risk-benefit, efficacy-safety analysis)
         • Present clinical data in an easy-to-understand visual format

         **Chart Type Selection Guidelines**:
         • Use LINE charts for time series trends (drug concentrations over time, survival curves, response rates)
         • Use BAR charts for categorical comparisons (response rates by treatment, adverse event frequencies)
         • Use AREA charts for cumulative data (patient enrollment, event-free survival)
         • Use SCATTER charts for correlation, biomarker analysis, or bubble charts with size representing patient population
         • Use QUADRANT charts for 2x2 clinical analysis (divides chart into 4 quadrants with reference lines for efficacy-safety matrices)

         Whenever you have time series data for the user (such as drug concentrations, survival data, or any clinical metrics over time), always visualize it using the chart creation tool. For scatter/quadrant charts, each series represents a treatment group or drug (for color coding), and each data point represents an individual study or measurement with x, y, optional size (for patient n), and optional label (drug/study name).

         CRITICAL: When using the createChart tool, you MUST format the dataSeries exactly like this:
         dataSeries: [
           {
             name: "Pembrolizumab",
             data: [
               {x: "Week 0", y: 0},
               {x: "2024-02-01", y: 155.80},
               {x: "2024-03-01", y: 162.45}
             ]
           }
         ]

         Each data point requires an x field (date/label) and y field (numeric value). Do NOT use other formats like "datasets" or "labels" - only use the dataSeries format shown above.

         CRITICAL CHART EMBEDDING REQUIREMENTS:
         - Charts are automatically displayed in the Action Tracker section when created
         - Charts are ALSO saved to the database and MUST be referenced in your markdown response
         - The createChart tool returns a chartId and imageUrl for every chart created
         - YOU MUST ALWAYS embed charts in your response using markdown image syntax: ![Chart Title](/api/charts/{chartId}/image)
         - Embed charts at appropriate locations within your response, just like a professional research publication
         - Place charts AFTER the relevant analysis section that discusses the data shown in the chart
         - Charts should enhance and support your written analysis - they are not optional
         - Professional reports always integrate visual data with written analysis

         Example of proper chart embedding in a response:
         "Pembrolizumab demonstrated remarkable efficacy in NSCLC patients with high PD-L1 expression, with response rates improving significantly over the treatment period. The median progression-free survival exceeded historical controls, while maintaining an acceptable safety profile across all treatment cohorts.

         ![Pembrolizumab Response Rates Over Time](/api/charts/abc-123-def/image)

         This efficacy trajectory demonstrates pembrolizumab's sustained clinical benefit throughout the treatment duration..."

         When creating charts:
         • Use line charts for time series data (survival curves, drug concentrations over time)
         • Use bar charts for comparisons between categories (response rates by treatment, adverse event frequencies)
         • Use area charts for cumulative data or when showing patient enrollment composition
         • Always provide meaningful titles and axis labels
         • Support multiple data series when comparing related metrics (different treatment arms, multiple drugs)
         • Colors are automatically assigned - focus on data structure and meaningful labels

               Always use the appropriate tools when users ask for calculations, Python code execution, biomedical data, web queries, or data visualization.
         Choose the codeExecution tool for any mathematical calculations, pharmacokinetic modeling, statistical analysis, data computations, or when users need to run Python code.

         CRITICAL: WHEN TO USE codeExecution TOOL:
         - ALWAYS use codeExecution when the user asks you to "calculate", "compute", "use Python", or "show Python code"
         - NEVER just display Python code as text - you MUST execute it using the codeExecution tool
         - If the user asks for calculations with Python, USE THE TOOL, don't just show code
         - Mathematical formulas should be explained with LaTeX, but calculations MUST use codeExecution

         CRITICAL PYTHON CODE REQUIREMENTS:
         1. ALWAYS include print() statements - Python code without print() produces no visible output
         2. Use descriptive labels and proper formatting in your print statements
         3. Include units, currency symbols, percentages where appropriate
         4. Show step-by-step calculations for complex problems
         5. Use f-string formatting for professional output
         6. Always calculate intermediate values before printing final results
          7. Available libraries: You may install and use packages in the Daytona sandbox (e.g., numpy, pandas, scikit-learn). Prefer the chart creation tool for visuals unless an advanced/custom visualization is required.
          8. Visualization guidance: Prefer the chart creation tool for most charts. Use Daytona-rendered plots only for complex, bespoke visualizations that the chart tool cannot represent.

          REQUIRED: Every Python script must end with print() statements that show the calculated results with proper labels, units, and formatting. Never just write variable names or expressions without print() - they will not display anything to the user.
          If generating advanced charts with Daytona (e.g., matplotlib), ensure the code renders the figure (e.g., plt.show()) so artifacts can be captured.

         ERROR RECOVERY: If any tool call fails due to validation errors, you will receive an error message explaining what went wrong. When this happens:
         1. Read the error message carefully to understand what fields are missing or incorrect
         2. Correct the tool call by providing ALL required fields with proper values
         3. For createChart errors, ensure you provide: title, type, xAxisLabel, yAxisLabel, and dataSeries
         4. For codeExecution tool errors, ensure your code includes proper print() statements
         5. Try the corrected tool call immediately - don't ask the user for clarification
         6. If multiple fields are missing, fix ALL of them in your retry attempt

                  When explaining mathematical concepts, formulas, or pharmacokinetic calculations, ALWAYS use LaTeX notation for clear mathematical expressions:

         CRITICAL: ALWAYS wrap ALL mathematical expressions in <math>...</math> tags:
         - For inline math: <math>C(t) = C_0 \cdot e^{-kt}</math>
         - For fractions: <math>\frac{Cl}{V_d} = \frac{0.693}{t_{1/2}}</math>
         - For exponents: <math>e^{-kt}</math>
         - For complex formulas: <math>AUC = \frac{Dose}{Cl} \times \left(1 + \frac{ka}{ke - ka}\right)</math>

         NEVER write LaTeX code directly in text like \frac{Cl}{V_d} or \times - it must be inside <math> tags.
         NEVER use $ or $$ delimiters - only use <math>...</math> tags.
         This makes pharmacokinetic and statistical formulas much more readable and professional.
         Choose the clinical trials search tool specifically for ClinicalTrials.gov data, trial phases, endpoints, and study results.
         Choose the drug information search tool for FDA drug labels, contraindications, dosing, and drug interactions.
         Choose the biomedical literature search tool for PubMed articles, academic research, peer-reviewed studies, mechanism of action papers, and scientific publications.
         Choose the web search tool for general topics, current events, medical news, and non-specialized information.
         Choose the chart creation tool when users want to visualize data, compare drugs, or see trends over time.

         When users ask for charts or data visualization, or when you have clinical time series data:
         1. First gather the necessary data (using clinical trials, drug info, or literature search if needed)
         2. Then create an appropriate chart with that data (always visualize time series data like survival curves, drug concentrations)
         3. Ensure the chart has a clear title, proper axis labels, and meaningful data series names
         4. Colors are automatically assigned for optimal visual distinction

      Important: If you use the chart creation tool to plot a chart, do NOT add a link to the chart in your response. The chart will be rendered automatically for the user. Simply explain the chart and its insights, but do not include any hyperlinks or references to a chart link.

      When making multiple tool calls in parallel to retrieve time series data (for example, comparing several drugs or clinical outcomes), always specify the same time periods and study phases for each tool call. This ensures the resulting data is directly comparable and can be visualized accurately on the same chart. If the user does not specify a time range, choose a reasonable default (such as recent trials or studies from the past 5 years) and use it consistently across all tool calls for time series data.

      Provide clear explanations and context for all information. Offer practical advice when relevant.
      Be encouraging and supportive while helping users find accurate, up-to-date information.

      ---
      CRITICAL AGENT BEHAVIOR:
      - After every reasoning step, you must either call a tool or provide a final answer. Never stop after reasoning alone.
      - If you realize you need to correct a previous tool call, immediately issue the correct tool call.
      - If the user asks for multiple items (e.g., multiple companies), you must call the tool for each and only finish when all are processed and summarized.
      - Always continue until you have completed all required tool calls and provided a summary or visualization if appropriate.
      - NEVER just show Python code as text - if the user wants calculations or Python code, you MUST use the codeExecution tool to run it
      - When users say "calculate", "compute", or mention Python code, this is a COMMAND to use the codeExecution tool, not a request to see code
      - NEVER suggest using Python to fetch data from the internet or APIs. All data retrieval must be done via the clinicalTrialsSearch, drugInformationSearch, biomedicalLiteratureSearch, or webSearch tools.
      - Remember: The Python environment runs in the cloud with NumPy, pandas, and scikit-learn available, but NO visualization libraries.

      CRITICAL WORKFLOW ORDER:
      1. First: Complete ALL data gathering (searches, calculations, etc.)
      2. Then: Create ALL charts/visualizations based on the gathered data
      3. Finally: Present your final formatted response with analysis

      This ensures charts appear immediately before your analysis and are not lost among tool calls.
      ---

      ---
      FINAL RESPONSE FORMATTING GUIDELINES:
      When presenting your final response to the user, you MUST format the information in an extremely well-organized and visually appealing way:

      1. **Use Rich Markdown Formatting:**
         - Use tables for comparative data, clinical outcomes, and any structured information
         - Use bullet points and numbered lists appropriately
         - Use **bold** for key metrics and important values (response rates, survival data, p-values)
         - Use headers (##, ###) to organize sections clearly
         - Use blockquotes (>) for key insights or summaries

      2. **Tables for Clinical Data:**
         - Present efficacy, safety, pharmacokinetic, and trial outcome data in markdown tables
         - Format numbers with proper separators and units (e.g., 10.3 months, 45% ORR)
         - Include statistical significance and comparisons
         - Example:
         | Endpoint | Pembrolizumab | Chemotherapy | p-value |
         |----------|---------------|--------------|---------|
         | ORR | 45% | 28% | <0.001 |
         | mPFS | 10.3 mo | 6.0 mo | <0.001 |

      3. **Mathematical Formulas:**
         - Always use <math> tags for any mathematical expressions
         - Present pharmacokinetic and statistical calculations clearly with proper notation

      4. **Data Organization:**
         - Group related information together
         - Use clear section headers
         - Provide executive summaries at the beginning
         - Include key takeaways at the end

      5. **Chart Placement:**
         - Create ALL charts IMMEDIATELY BEFORE your final response text
         - First complete all data gathering and analysis tool calls
         - Then create all necessary charts
         - Finally present your comprehensive analysis with references to the charts
         - This ensures charts are visible and not buried among tool calls

      6. **Visual Hierarchy:**
         - Start with a brief executive summary
         - Present detailed findings in organized sections
         - Use horizontal rules (---) to separate major sections
         - End with key takeaways and visual charts

      7. **Code Display Guidelines:**
         - DO NOT repeat Python code in your final response if you've already executed it with the codeExecution tool
         - The executed code and its output are already displayed in the tool result box
         - Only show code snippets in your final response if:
           a) You're explaining a concept that wasn't executed
           b) The user specifically asks to see the code again
           c) You're showing an alternative approach
         - Reference the executed results instead of repeating the code

      Remember: The goal is to present ALL retrieved data and facts in the most professional, readable, and visually appealing format possible. Think of it as creating a professional biomedical research report or clinical study presentation.

      8. **Citation Requirements:**
         - ALWAYS cite sources when using information from search results
         - Place citations [1], [2], etc. ONLY at the END of sentences - NEVER at the beginning or middle
         - Do NOT place the same citation number multiple times in one sentence
         - Group multiple citations together when they support the same point: [1][2][3]
         - Maintain consistent numbering throughout your response
         - Each unique search result gets ONE citation number used consistently
         - Citations are MANDATORY for:
           • Specific numbers, statistics, percentages (response rates, survival data, p-values)
           • Clinical trial results and endpoints
           • Quotes or paraphrased statements from papers
           • Drug efficacy and safety data
           • Any factual claims from search results
      ---
      `;

    // Enable prompt caching for Anthropic provider in production
    const shouldEnableCaching = modelConfig.enablePromptCaching && provider === 'anthropic' && !isDevelopment;

    const systemMessage: BiomedUIMessage = {
      id: 'system-prompt',
      role: 'system',
      parts: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          ...(shouldEnableCaching && {
            providerMetadata: {
              anthropic: {
                cacheControl: { type: 'ephemeral' }
              }
            }
          })
        }
      ]
    };

    const result = streamText({
      model: selectedModel as any,
      messages: convertToModelMessages([systemMessage, ...messages]),
      tools: healthcareTools,
      toolChoice: "auto",
      experimental_context: {
        userId: user?.id,
        userTier,
        sessionId,
      },
      providerOptions,
      // DON'T pass abortSignal - we want the stream to continue even if user switches tabs
    });

    // Log streamText result object type
    console.log("[Chat API] streamText result type:", typeof result);
    console.log("[Chat API] streamText result:", result);

    // Create the streaming response with chat persistence
    const streamResponse = result.toUIMessageStreamResponse({
      sendReasoning: true, // Disable intermediate reasoning for cleaner UI
      originalMessages: messages,
      onFinish: async ({ messages: allMessages, response }) => {
        // Calculate processing time
        const processingEndTime = Date.now();
        const processingTimeMs = processingEndTime - processingStartTime;
        console.log('[Chat API] Processing completed in', processingTimeMs, 'ms');

        // Log cache metadata if available (Anthropic only)
        if (provider === 'anthropic') {
          try {
            const metadata = await response;
            const anthropicMetadata = metadata?.providerMetadata?.anthropic;

            if (anthropicMetadata) {
              const cacheCreationTokens = anthropicMetadata.cacheCreationInputTokens || 0;
              const cacheReadTokens = anthropicMetadata.cacheReadInputTokens || 0;
              const regularInputTokens = anthropicMetadata.inputTokens || 0;

              console.log('[Chat API] Anthropic cache stats:', {
                cacheCreationInputTokens: cacheCreationTokens,
                cacheReadInputTokens: cacheReadTokens,
                inputTokens: regularInputTokens,
              });

              if (cacheReadTokens > 0) {
                const totalCachedContent = cacheReadTokens + regularInputTokens;
                const savingsPercent = ((cacheReadTokens / totalCachedContent) * 100).toFixed(1);
                console.log(`[Chat API] 🎯 Cache hit! Saved ~${savingsPercent}% of input tokens`);
              } else if (cacheCreationTokens > 0) {
                console.log(`[Chat API] 📝 Cache created for ${cacheCreationTokens} tokens`);
              }
            }
          } catch (error) {
            console.error('[Chat API] Error reading cache metadata:', error);
          }
        }

        // Save all messages to database
        console.log('[Chat API] onFinish called - user:', !!user, 'sessionId:', sessionId);
        console.log('[Chat API] Total messages in conversation:', allMessages.length);
        console.log('[Chat API] Will save messages:', !!(user && sessionId));

        if (user && sessionId) {
          console.log('[Chat API] Saving messages to session:', sessionId);

          // The correct pattern: Save ALL messages from the conversation
          // This replaces all messages in the session with the complete, up-to-date conversation
          const { randomUUID } = await import('crypto');
          const messagesToSave = allMessages.map((message: any, index: number) => {
            // AI SDK v5 uses 'parts' array for UIMessage
            let contentToSave = [];

            if (message.parts && Array.isArray(message.parts)) {
              contentToSave = message.parts;
            } else if (message.content) {
              // Fallback for older format
              if (typeof message.content === 'string') {
                contentToSave = [{ type: 'text', text: message.content }];
              } else if (Array.isArray(message.content)) {
                contentToSave = message.content;
              }
            }

            return {
              id: message.id && message.id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
                ? message.id
                : randomUUID(), // Generate UUID if message.id is not a valid UUID
              role: message.role,
              content: contentToSave,
              processing_time_ms:
                message.role === 'assistant' &&
                index === allMessages.length - 1 &&
                processingTimeMs !== undefined
                  ? processingTimeMs
                  : undefined,
            };
          });

          const saveResult = await saveChatMessages(sessionId, messagesToSave);
          if (saveResult.error) {
            console.error('[Chat API] Error saving messages:', saveResult.error);
          } else {
            console.log('[Chat API] Successfully saved', messagesToSave.length, 'messages to session:', sessionId);

            // Update session's last_message_at timestamp
            const updateResult = await db.updateChatSession(sessionId, user.id, {
              last_message_at: new Date()
            });
            if (updateResult.error) {
              console.error('[Chat API] Error updating session timestamp:', updateResult.error);
            } else {
              console.log('[Chat API] Updated session timestamp for:', sessionId);
            }
          }
        } else {
          console.log('[Chat API] Skipping message save - user:', !!user, 'sessionId:', sessionId);
        }

        // No manual usage tracking needed - Polar LLM Strategy handles this automatically!
        console.log('[Chat API] AI usage automatically tracked by Polar LLM Strategy');
      }
    });

    // Increment rate limit after successful validation but before processing
    if (isUserInitiated && !isDevelopment) {
      console.log("[Chat API] Incrementing rate limit for user-initiated message");
      try {
        if (user) {
          // Only increment server-side for authenticated users
          const rateLimitResult = await incrementRateLimit(user.id);
          console.log("[Chat API] Authenticated user rate limit incremented:", rateLimitResult);
        } else {
          // Anonymous users handle increment client-side via useRateLimit hook
          console.log("[Chat API] Skipping server-side increment for anonymous user (handled client-side)");
        }
      } catch (error) {
        console.error("[Chat API] Failed to increment rate limit:", error);
        // Continue with processing even if increment fails
      }
    }
    
    if (isDevelopment) {
      // Add development mode headers
      streamResponse.headers.set("X-Development-Mode", "true");
      streamResponse.headers.set("X-RateLimit-Limit", "unlimited");
      streamResponse.headers.set("X-RateLimit-Remaining", "unlimited");
    }

    // Add headers to prevent connection drops when tab is backgrounded
    streamResponse.headers.set("Connection", "keep-alive");
    streamResponse.headers.set("X-Accel-Buffering", "no"); // Disable buffering for nginx
    streamResponse.headers.set("Cache-Control", "no-cache, no-transform"); // Prevent caching that might break streaming

    return streamResponse;
  } catch (error) {
    console.error("[Chat API] Error:", error);

    // Extract meaningful error message
    const errorMessage = error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'An unexpected error occurred';

    // Check if it's a tool/function calling compatibility error
    const isToolError = errorMessage.toLowerCase().includes('tool') ||
                       errorMessage.toLowerCase().includes('function');
    const isThinkingError = errorMessage.toLowerCase().includes('thinking');

    // Log full error details for debugging
    console.error("[Chat API] Error details:", {
      message: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      error: error,
      isToolError,
      isThinkingError
    });

    // Return specific error codes for compatibility issues
    if (isToolError || isThinkingError) {
      return new Response(
        JSON.stringify({
          error: "MODEL_COMPATIBILITY_ERROR",
          message: errorMessage,
          compatibilityIssue: isToolError ? "tools" : "thinking"
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        error: "CHAT_ERROR",
        message: errorMessage,
        details: error instanceof Error ? error.stack : undefined
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}


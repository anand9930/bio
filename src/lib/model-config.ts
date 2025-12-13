// Model configuration utility for multi-provider support
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";

export type ModelProvider = "openai" | "anthropic";

export type GatewayStrategy = "disabled" | "fallback" | "primary" | "gateway-only";

export interface GatewayConfig {
  enabled: boolean;
  strategy: GatewayStrategy;
  apiKey?: string;
  providerOrder: ModelProvider[];
  modelFallbacks: string[];
  enableUserTracking: boolean;
  enableFeatureTags: boolean;
}

export interface ModelSelectionContext {
  userId?: string;
  userTier?: 'free' | 'pay_per_use' | 'unlimited';
  feature?: 'chat' | 'title-generation';
  isDevelopment: boolean;
}

export interface SelectedModelInfo {
  model: any;
  description: string;
  usesGateway: boolean;
  tags?: string[];
}

export interface ModelConfig {
  provider: ModelProvider;
  primaryModel: string;
  titleModel: string;
  hasApiKey: boolean;
  gateway: GatewayConfig;
  enablePromptCaching?: boolean;
}

/**
 * Get the configured model provider from environment
 * Defaults to Anthropic if not specified
 */
export function getModelProvider(): ModelProvider {
  const provider = process.env.MODEL_PROVIDER?.toLowerCase().trim();

  // Default to Anthropic
  if (!provider || provider === "anthropic") {
    return "anthropic";
  }

  if (provider === "openai") {
    return "openai";
  }

  // Invalid provider, log warning and default to Anthropic
  console.warn(`[Model Config] Invalid MODEL_PROVIDER: "${provider}". Defaulting to anthropic.`);
  return "anthropic";
}

/**
 * Parse gateway configuration from environment variables
 */
export function getGatewayConfig(): GatewayConfig {
  const strategy = (process.env.AI_GATEWAY_STRATEGY?.toLowerCase() || "disabled") as GatewayStrategy;
  const validStrategies: GatewayStrategy[] = ["disabled", "fallback", "primary", "gateway-only"];

  if (!validStrategies.includes(strategy)) {
    console.warn(`[Gateway Config] Invalid AI_GATEWAY_STRATEGY: "${strategy}". Defaulting to "disabled".`);
    return {
      enabled: false,
      strategy: "disabled",
      providerOrder: [],
      modelFallbacks: [],
      enableUserTracking: false,
      enableFeatureTags: false,
    };
  }

  const enabled = strategy !== "disabled";
  const apiKey = process.env.AI_GATEWAY_API_KEY;

  // Parse provider order
  const providerOrderStr = process.env.AI_GATEWAY_PROVIDER_ORDER || "";
  const providerOrder: ModelProvider[] = providerOrderStr
    .split(",")
    .map(p => p.trim().toLowerCase())
    .filter(p => p === "anthropic" || p === "openai") as ModelProvider[];

  // Parse model fallbacks
  const modelFallbacksStr = process.env.AI_GATEWAY_MODEL_FALLBACKS || "";
  const modelFallbacks = modelFallbacksStr
    .split(",")
    .map(m => m.trim())
    .filter(m => m.includes("/"));

  // Validation: gateway-only requires API key
  if (strategy === "gateway-only" && !apiKey) {
    console.error("[Gateway Config] AI_GATEWAY_STRATEGY=gateway-only requires AI_GATEWAY_API_KEY");
    console.warn("[Gateway Config] Falling back to 'disabled' strategy");
    return {
      enabled: false,
      strategy: "disabled",
      providerOrder: [],
      modelFallbacks: [],
      enableUserTracking: false,
      enableFeatureTags: false,
    };
  }

  return {
    enabled,
    strategy,
    apiKey,
    providerOrder,
    modelFallbacks,
    enableUserTracking: process.env.AI_GATEWAY_ENABLE_USER_TRACKING === "true",
    enableFeatureTags: process.env.AI_GATEWAY_ENABLE_FEATURE_TAGS === "true",
  };
}

/**
 * Check if running on Vercel (OIDC authentication available)
 */
function isVercelDeployment(): boolean {
  return !!process.env.VERCEL || !!process.env.VERCEL_ENV;
}

/**
 * Get model configuration based on provider
 */
export function getModelConfig(): ModelConfig {
  const provider = getModelProvider();
  const gateway = getGatewayConfig();

  // Check if prompt caching is enabled (default: true)
  const enablePromptCaching = process.env.ANTHROPIC_ENABLE_PROMPT_CACHING !== 'false';

  if (provider === "anthropic") {
    return {
      provider: "anthropic",
      primaryModel: "claude-sonnet-4-5-20250929",
      titleModel: "claude-3-5-haiku-20241022", // Fast, cheap model for titles
      hasApiKey: !!process.env.ANTHROPIC_API_KEY,
      gateway,
      enablePromptCaching,
    };
  }

  // OpenAI
  return {
    provider: "openai",
    primaryModel: "gpt-5",
    titleModel: "gpt-5-nano",
    hasApiKey: !!process.env.OPENAI_API_KEY,
    gateway,
    enablePromptCaching: false, // OpenAI doesn't support this yet
  };
}

/**
 * Intelligent model selection based on gateway strategy and context
 */
export function selectModel(
  modelId: string,
  context: ModelSelectionContext
): SelectedModelInfo {
  const modelConfig = getModelConfig();
  const provider = modelConfig.provider;
  const gateway = modelConfig.gateway;

  // Strategy 1: Gateway disabled - use direct API keys only
  if (gateway.strategy === "disabled") {
    return selectDirectModel(modelId, modelConfig, context);
  }

  // Strategy 2: Gateway-only - always use gateway
  if (gateway.strategy === "gateway-only") {
    return selectGatewayModel(modelId, modelConfig, context);
  }

  // Strategy 3: Fallback - use direct if available, gateway otherwise
  if (gateway.strategy === "fallback") {
    if (modelConfig.hasApiKey) {
      return selectDirectModel(modelId, modelConfig, context);
    }
    return selectGatewayModel(modelId, modelConfig, context);
  }

  // Strategy 4: Primary - use gateway if available, direct otherwise
  if (gateway.strategy === "primary") {
    if (gateway.apiKey || isVercelDeployment()) {
      return selectGatewayModel(modelId, modelConfig, context);
    }
    return selectDirectModel(modelId, modelConfig, context);
  }

  // Fallback to direct (should never reach here)
  return selectDirectModel(modelId, modelConfig, context);
}

/**
 * Select direct API model (non-gateway)
 */
function selectDirectModel(
  modelId: string,
  modelConfig: ModelConfig,
  context: ModelSelectionContext
): SelectedModelInfo {
  const provider = modelConfig.provider;

  if (!modelConfig.hasApiKey) {
    throw new Error(
      `${provider.toUpperCase()}_API_KEY is required when gateway is disabled or unavailable`
    );
  }

  // For pay-per-use users, wrap with Polar tracking
  if (context.userTier === 'pay_per_use' && context.userId && !context.isDevelopment) {
    const { getPolarTrackedModel } = require('./polar-llm-strategy');
    return {
      model: getPolarTrackedModel(context.userId, modelId),
      description: `${provider === "anthropic" ? "Anthropic" : "OpenAI"} (${modelId}) - Polar Tracked`,
      usesGateway: false,
    };
  }

  // Regular direct API model
  const model = provider === "anthropic"
    ? anthropic(modelId)
    : openai(modelId);

  return {
    model,
    description: `${provider === "anthropic" ? "Anthropic" : "OpenAI"} (${modelId}) - Direct API`,
    usesGateway: false,
  };
}

/**
 * Select gateway model with advanced features
 */
function selectGatewayModel(
  modelId: string,
  modelConfig: ModelConfig,
  context: ModelSelectionContext
): SelectedModelInfo {
  const provider = modelConfig.provider;
  const gateway = modelConfig.gateway;

  // Basic gateway format: "provider/model"
  const gatewayModelId = `${provider}/${modelId}`;

  // Build tags for usage tracking
  const tags: string[] = [];

  if (gateway.enableFeatureTags && context.feature) {
    tags.push(`feature:${context.feature}`);
  }

  if (gateway.enableUserTracking && context.userTier) {
    tags.push(`tier:${context.userTier}`);
  }

  return {
    model: gatewayModelId,
    description: `Vercel AI Gateway (${gatewayModelId})${context.isDevelopment ? ' - Development' : ''}`,
    usesGateway: true,
    tags,
  };
}

/**
 * Create a model instance for the configured provider
 * @deprecated Use selectModel() instead for gateway support
 */
export function createModel(modelId: string) {
  const provider = getModelProvider();

  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is required when MODEL_PROVIDER=anthropic");
    }
    return anthropic(modelId);
  }

  // OpenAI
  if (!process.env.OPENAI_API_KEY) {
    // Fallback to Vercel AI Gateway
    console.warn("[Model Config] OPENAI_API_KEY not found, using Vercel AI Gateway");
    return `openai/${modelId}`;
  }

  return openai(modelId);
}

/**
 * Get provider-specific options for streamText/generateText
 * Includes gateway configuration when applicable
 */
export function getProviderOptions(
  provider: ModelProvider,
  context?: {
    userId?: string;
    userTier?: string;
    feature?: string;
    usesGateway?: boolean;
    tags?: string[];
  }
): any {
  const modelConfig = getModelConfig();
  const gateway = modelConfig.gateway;

  // Base provider options
  const baseOptions = provider === "anthropic"
    ? {
        anthropic: {
          // Add Anthropic-specific options here if needed in the future
          // Currently, no special options required
        }
      }
    : {
        openai: {
          store: true,
          reasoningEffort: 'medium',
          reasoningSummary: 'auto',
          include: ['reasoning.encrypted_content'],
        }
      };

  // If not using gateway, return base options only
  if (!context?.usesGateway || !gateway.enabled) {
    return baseOptions;
  }

  // Build gateway options
  const gatewayOptions: any = {};

  // Provider ordering for failover
  if (gateway.providerOrder.length > 0) {
    gatewayOptions.order = gateway.providerOrder;
  }

  // Model fallbacks
  if (gateway.modelFallbacks.length > 0) {
    gatewayOptions.models = gateway.modelFallbacks;
  }

  // User tracking
  if (gateway.enableUserTracking && context.userId) {
    gatewayOptions.user = context.userId;
  }

  // Tags (feature + tier)
  if (context.tags && context.tags.length > 0) {
    gatewayOptions.tags = context.tags;
  }

  // Merge gateway options with provider options
  return {
    ...baseOptions,
    gateway: gatewayOptions,
  };
}

/**
 * Get human-readable model information string
 */
export function getModelInfoString(
  modelId: string,
  provider: ModelProvider,
  context: "development" | "production" | "polar-tracked",
  userTier?: string
): string {
  const providerName = provider === "anthropic" ? "Anthropic" : "OpenAI";
  const displayModel = provider === "anthropic" ? "Claude Sonnet 4.5" : modelId;

  if (context === "development") {
    return `${providerName} (${displayModel}) - Development Mode`;
  }

  if (context === "polar-tracked") {
    return `${providerName} (${displayModel}) - Production Mode (Polar Tracked - Pay-per-use)`;
  }

  // Production mode
  if (userTier) {
    return `${providerName} (${displayModel}) - Production Mode (${userTier} tier - Flat Rate)`;
  }

  return `${providerName} (${displayModel}) - Production Mode (Anonymous)`;
}

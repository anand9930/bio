// Environment variable validation for critical payment and billing systems

interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePaymentEnvironment(): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  const isDevelopment = process.env.NODE_ENV === 'development';
  const isProduction = !isDevelopment;

  // Core Supabase requirements (always required)
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    errors.push('NEXT_PUBLIC_SUPABASE_URL is required');
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    errors.push('NEXT_PUBLIC_SUPABASE_ANON_KEY is required');
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    errors.push('SUPABASE_SERVICE_ROLE_KEY is required');
  }

  // Production-only requirements
  if (isProduction) {
    // Polar requirements
    if (!process.env.POLAR_ACCESS_TOKEN) {
      errors.push('POLAR_ACCESS_TOKEN is required in production');
    }
    if (!process.env.POLAR_WEBHOOK_SECRET) {
      errors.push('POLAR_WEBHOOK_SECRET is required in production');
    }
    if (!process.env.POLAR_UNLIMITED_PRODUCT_ID) {
      errors.push('POLAR_UNLIMITED_PRODUCT_ID is required in production');
    }
    if (!process.env.POLAR_PAY_PER_USE_PRODUCT_ID) {
      errors.push('POLAR_PAY_PER_USE_PRODUCT_ID is required in production');
    }
    
    // API keys for usage tracking
    if (!process.env.VALYU_API_KEY) {
      warnings.push('VALYU_API_KEY missing - biomedical/web search will fail');
    }
    if (!process.env.DAYTONA_API_KEY) {
      warnings.push('DAYTONA_API_KEY missing - code execution will fail');
    }
    if (!process.env.OPENAI_API_KEY) {
      warnings.push('OPENAI_API_KEY missing - will use Vercel AI Gateway');
    }
  }

  // Development warnings
  if (isDevelopment) {
    if (!process.env.POLAR_ACCESS_TOKEN) {
      warnings.push('POLAR_ACCESS_TOKEN missing - payment testing will be limited');
    }
    if (!process.env.POLAR_PAY_PER_USE_PRODUCT_ID) {
      warnings.push('POLAR_PAY_PER_USE_PRODUCT_ID missing - cannot test pay-per-use flow');
    }
  }

  // Validate URL formats
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && !process.env.NEXT_PUBLIC_SUPABASE_URL.startsWith('https://')) {
    errors.push('NEXT_PUBLIC_SUPABASE_URL must be a valid HTTPS URL');
  }

  // AI Gateway validation
  const gatewayStrategy = process.env.AI_GATEWAY_STRATEGY?.toLowerCase();
  if (gatewayStrategy === 'gateway-only' && !process.env.AI_GATEWAY_API_KEY) {
    errors.push('AI_GATEWAY_API_KEY is required when AI_GATEWAY_STRATEGY=gateway-only');
  }

  if (gatewayStrategy === 'primary' && !process.env.AI_GATEWAY_API_KEY) {
    warnings.push('AI_GATEWAY_API_KEY recommended when AI_GATEWAY_STRATEGY=primary (will use direct API as fallback)');
  }

  // Validate provider order
  const providerOrder = process.env.AI_GATEWAY_PROVIDER_ORDER?.split(',') || [];
  const invalidProviders = providerOrder.filter(p =>
    !['anthropic', 'openai', 'vertex', ''].includes(p.trim().toLowerCase())
  );
  if (invalidProviders.length > 0) {
    warnings.push(`AI_GATEWAY_PROVIDER_ORDER contains invalid providers: ${invalidProviders.join(', ')}`);
  }

  // Validate model fallbacks format
  const modelFallbacks = process.env.AI_GATEWAY_MODEL_FALLBACKS?.split(',') || [];
  const invalidFallbacks = modelFallbacks.filter(m =>
    m.trim() !== '' && !m.includes('/')
  );
  if (invalidFallbacks.length > 0) {
    warnings.push(`AI_GATEWAY_MODEL_FALLBACKS should be in format "provider/model": ${invalidFallbacks.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export function logEnvironmentStatus(): void {
  const validation = validatePaymentEnvironment();
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  if (validation.valid) {
  } else {
    validation.errors.forEach(error => console.error(`  - ${error}`));
  }
  
  if (validation.warnings.length > 0) {
    validation.warnings.forEach(warning => console.warn(`  - ${warning}`));
  }
}

// Auto-validate on import in production
if (process.env.NODE_ENV !== 'development') {
  const validation = validatePaymentEnvironment();
  if (!validation.valid) {
    validation.errors.forEach(error => console.error(`  - ${error}`));
    // Don't throw in production to avoid complete app failure, but log critically
  }
}
import dotenv from 'dotenv';

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5175')
    .split(',')
    .map((o) => o.trim()),

  // Where uploaded job-work documents are stored on disk.
  uploadDir: process.env.UPLOAD_DIR ?? 'uploads',

  // LLM provider config. Provider-neutral: pick 'openai' or 'claude' later.
  // Left unset for now → falls back to the built-in 'stub' provider so the
  // whole flow works end-to-end without any API key.
  llm: {
    provider: (process.env.LLM_PROVIDER ?? 'stub') as 'stub' | 'openai' | 'claude',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8',
  },
};

export const isProduction = env.nodeEnv === 'production';

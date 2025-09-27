/**
 * Утилита для повторных попыток запросов к Supabase при сетевых ошибках
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  backoffFactor: 2,
};

/**
 * Выполняет функцию с повторными попытками при ошибках
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      // Если это последняя попытка, выбрасываем ошибку
      if (attempt === opts.maxRetries) {
        break;
      }

      // Проверяем, стоит ли повторять попытку
      if (!shouldRetry(error)) {
        break;
      }

      // Вычисляем задержку с экспоненциальным backoff
      const delay = Math.min(
        opts.baseDelay * Math.pow(opts.backoffFactor, attempt),
        opts.maxDelay
      );

      console.warn(
        `🔄 Попытка ${attempt + 1}/${opts.maxRetries + 1} неудачна, повтор через ${delay}ms:`,
        error
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

/**
 * Определяет, стоит ли повторять попытку при данной ошибке
 */
function shouldRetry(error: any): boolean {
  // Сетевые ошибки
  if (error?.name === 'TypeError' && error?.message?.includes('NetworkError')) {
    return true;
  }

  // Ошибки Supabase
  if (error?.code === 'PGRST002') {
    return true;
  }

  // HTTP ошибки 5xx
  if (error?.status >= 500 && error?.status < 600) {
    return true;
  }

  // Таймауты
  if (error?.name === 'AbortError' || error?.message?.includes('timeout')) {
    return true;
  }

  return false;
}

/**
 * Обертка для Supabase запросов с автоматическими повторными попытками
 */
export function createSupabaseRetryWrapper() {
  return {
    async query<T>(queryFn: () => Promise<T>, options?: RetryOptions): Promise<T> {
      return withRetry(queryFn, options);
    },

    async mutation<T>(mutationFn: () => Promise<T>, options?: RetryOptions): Promise<T> {
      return withRetry(mutationFn, options);
    },

    async auth<T>(authFn: () => Promise<T>, options?: RetryOptions): Promise<T> {
      return withRetry(authFn, options);
    },

    async storage<T>(storageFn: () => Promise<T>, options?: RetryOptions): Promise<T> {
      return withRetry(storageFn, options);
    },
  };
}

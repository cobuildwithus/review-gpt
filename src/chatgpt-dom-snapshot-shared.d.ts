export const CHATGPT_ASSISTANT_TURN_SELECTOR: string;
export const CHATGPT_COPY_SELECTORS: string[];
export const CHATGPT_STATUS_SELECTORS: string[];
export const CHATGPT_STOP_SELECTORS: string[];
export const CHATGPT_USER_TURN_SELECTOR: string;

export function buildChatGptCaptureStateExpression(input?: {
  desiredChatId?: string;
  desiredOrigin?: string;
}): string;
export function buildDeepResearchResponseInspectionSource(): string;

export function chatGptTextIndicatesRateLimit(value: string): boolean;
export function normalizeComparableText(value: unknown): string;
export function normalizeResponseText(value: unknown): string;
export function sanitizeDeepResearchResponseText(value: unknown): string;
export function threadStatusTextIndicatesBusy(value: string): boolean;

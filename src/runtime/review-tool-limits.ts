/**
 * What a review lead can read from one native-tool result.
 *
 * Claude Code hands the model an MCP tool result inline only up to two
 * limits, and replaces a longer one with a pointer to a file the confined
 * review lead cannot open (probed on 2.1.309): a per-tool size limit (about
 * 50,000 characters unless the tool declares `anthropic/maxResultSizeChars`
 * in its `_meta`) and an output-token cap (`MAX_MCP_OUTPUT_TOKENS`, 25,000 by
 * default). The review MCP bridge declares the size and review sessions run
 * with the token cap set, so the host's own text bound decides what reaches
 * the lead, on every runtime.
 */

/** Host bound on one model-facing tool text, in UTF-8 bytes (which bound
 * its characters from above). A result over it takes the tool's honest
 * not-delivered path. */
export const REVIEW_TOOL_TEXT_MAX_BYTES = 192 * 1024;

/** The per-tool inline size the review MCP bridge declares to Claude Code
 * (`_meta["anthropic/maxResultSizeChars"]`), above the host bound. */
export const REVIEW_TOOL_RESULT_MAX_CHARS = 200_000;

/** `MAX_MCP_OUTPUT_TOKENS` for review sessions: at least one token per two
 * characters of the declared size, so the token cap never cuts a result the
 * size limit admits. */
export const REVIEW_MCP_OUTPUT_TOKENS = 100_000;

"use client";

import { memo } from "react";
import { MemoizedMarkdown } from "@/components/chat/markdown/memoized-markdown";

// Memoized Notebook Execution Result - prevents re-rendering when props don't change
// Displays code input, text output, and matplotlib/seaborn visualizations
export const MemoizedNotebookExecutionResult = memo(function MemoizedNotebookExecutionResult({
  code,
  output,
  images,
  sessionInfo,
  actionId,
  expandedTools,
  toggleToolExpansion
}: {
  code: string;
  output: string;
  images?: Array<{ format: string, base64: string }>;
  sessionInfo: string;
  actionId: string;
  expandedTools: Set<string>;
  toggleToolExpansion: (id: string) => void;
}) {
  const isExpanded = expandedTools.has(actionId);

  // Escape HTML entities to prevent rendering <module> and other HTML-like content as actual HTML
  const escapeHtml = (text: string) => {
    if (typeof document === 'undefined') return text;
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  };

  return (
    <div className="space-y-4">
      {/* Session persistence badge */}
      <div className="inline-flex items-center gap-2 px-3 py-1 bg-purple-100 dark:bg-purple-900/30 rounded-full text-xs font-medium text-purple-700 dark:text-purple-300">
        🔬 {sessionInfo}
      </div>

      {/* Code Input Section */}
      <div>
        <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2 uppercase tracking-wide">
          Input Code
        </div>
        <pre className="p-4 bg-gray-900 dark:bg-black/40 text-gray-100 text-xs overflow-x-auto rounded-lg max-h-[400px] overflow-y-auto border border-gray-800 dark:border-gray-800/50 shadow-inner">
          <code>{code || "No code available"}</code>
        </pre>
      </div>

      {/* Text Output Section */}
      {output && (
        <div>
          <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2 uppercase tracking-wide">
            Output
          </div>
          <div className="prose prose-sm max-w-none dark:prose-invert text-sm p-4 bg-white dark:bg-gray-800/50 rounded-lg max-h-[400px] overflow-y-auto border border-gray-200 dark:border-gray-700/50">
            <MemoizedMarkdown text={escapeHtml(output)} />
          </div>
        </div>
      )}

      {/* Visualizations Section */}
      {images && images.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2 uppercase tracking-wide flex items-center gap-2">
            <span>Visualizations</span>
            <span className="px-2 py-0.5 bg-purple-100 dark:bg-purple-900/30 rounded text-purple-700 dark:text-purple-300">
              {images.length} {images.length === 1 ? 'plot' : 'plots'}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {images.map((img, idx) => (
              <div
                key={idx}
                className="relative group overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 shadow-sm hover:shadow-md transition-shadow"
              >
                <img
                  src={`data:image/${img.format};base64,${img.base64}`}
                  alt={`Visualization ${idx + 1}`}
                  className="w-full h-auto"
                />
                {/* Visualization number badge */}
                <div className="absolute top-2 left-2 px-2 py-1 bg-black/70 text-white text-xs rounded-full">
                  Plot {idx + 1}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  // Only re-render if these specific props change
  return (
    prevProps.code === nextProps.code &&
    prevProps.output === nextProps.output &&
    prevProps.sessionInfo === nextProps.sessionInfo &&
    prevProps.actionId === nextProps.actionId &&
    prevProps.expandedTools === nextProps.expandedTools &&
    JSON.stringify(prevProps.images) === JSON.stringify(nextProps.images)
  );
});

MemoizedNotebookExecutionResult.displayName = 'MemoizedNotebookExecutionResult';

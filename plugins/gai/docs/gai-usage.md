## gai (Google AI search)

`gai` is a CLI that queries Google's AI Mode (the synthesized answer panel above
normal search results) and returns the answer as text or JSON. Use it for
up-to-date, synthesized answers with sources when a quick research or debugging
question would otherwise need a web search.

- `gai "query"` prints the answer (JSON when piped, plain text in a terminal).
- `gaimd "query"` renders the answer as markdown.
- Pipe content in for context: `cat file.ts | gai "explain this"`, `git diff | gai "review these changes"`.
- Be specific, use precise terminology, one topic per query.

Reach for `gai` before manual investigation on questions like library/API usage,
error messages, recent releases, or "how do I X". It is faster than reading docs
by hand and returns a synthesized answer instead of a list of links.

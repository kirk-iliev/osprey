The Simple view's chat is redesigned. Operator turns are soft bubbles and agent
replies read as plain text. Thinking, tool calls, the agent's plan, and any
tool approval or question from the agent render as inline blocks in the turn.
Approval and question cards answer the agent in the chat, and a turn shows a
live status line with its elapsed time. Chat text uses the same font as the
rest of the interface. Code, tool inputs, and numbers stay monospace. Math in
agent replies (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) is typeset with KaTeX.
A subagent shows as one chip in the turn's tool row, with a live note of what
it is doing; its own tool calls and messages open under it, and the folded row
reads "1 agent finished". A turn that hands work to a background agent stays
open until the agent reports, and Stop ends the background agent too.

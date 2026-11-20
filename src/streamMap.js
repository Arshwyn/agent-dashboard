'use strict';

// Turns the CLI's stream-json lines into a small, safe event set for the browser:
//   session  a session was created or resumed (the init event)
//   delta    a piece of the reply text
//   interim  the text so far was narration before a tool call (the client shows it as a muted note)
//   tool     a generic label such as "reading"; never a tool name's arguments, never a result
//   result   the final result (isError flag and the final text), consumed by the server, not forwarded raw
// Tool inputs, tool outputs, thinking blocks and every other field are dropped here on purpose.

function toolLabel(name) {
  if (typeof name !== 'string') return 'working';
  if (name.startsWith('mcp__')) return 'using a connector';
  if (['Read', 'Grep', 'Glob'].includes(name)) return 'reading';
  if (['Write', 'Edit', 'NotebookEdit'].includes(name)) return 'writing';
  if (['WebSearch', 'WebFetch'].includes(name)) return 'searching the web';
  if (['Bash', 'BashOutput', 'KillShell'].includes(name)) return 'running a command';
  if (name === 'Task' || name === 'Agent') return 'asking a helper';
  return 'working';
}

function createStreamMapper() {
  const seenTools = new Set();
  let hadText = false;
  let current = '';
  return {
    push(line) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        return [];
      }
      if (!o || typeof o !== 'object') return [];
      const out = [];
      const tool = (id, name) => {
        if (id && seenTools.has(id)) return;
        if (id) seenTools.add(id);
        if (current.trim()) out.push({ kind: 'interim', text: current });
        current = '';
        hadText = false;
        out.push({ kind: 'tool', label: toolLabel(name) });
      };
      if (o.type === 'system' && o.subtype === 'init') {
        out.push({ kind: 'session' });
      } else if (o.type === 'stream_event' && o.event) {
        const e = o.event;
        if (e.type === 'content_block_start' && e.content_block?.type === 'text' && hadText) {
          current += '\n\n';
          out.push({ kind: 'delta', text: '\n\n' });
        } else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          tool(e.content_block.id, e.content_block.name);
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          hadText = true;
          current += e.delta.text;
          out.push({ kind: 'delta', text: e.delta.text });
        }
      } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
        for (const c of o.message.content) if (c && c.type === 'tool_use') tool(c.id, c.name);
      } else if (o.type === 'result') {
        out.push({
          kind: 'result',
          isError: o.is_error === true,
          text: typeof o.result === 'string' ? o.result : '',
        });
      }
      return out;
    },
    /** Text since the last tool call: the final answer. */
    finalText() {
      return current;
    },
  };
}

module.exports = { createStreamMapper, toolLabel };

export type WritableChannelOption = {
  skey: string;
  name: string;
  visibility: "public" | "private";
};

export type AdminHookRow = {
  id: string;
  channelSkey: string;
  channelName: string;
  visibility: "public" | "private";
  status: "active" | "unavailable";
  unavailableReason?: string;
  canRotate: boolean;
  canRevoke: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AdminWorkspaceView = {
  uri: string;
  name: string;
  writableChannels: WritableChannelOption[];
  hooks: AdminHookRow[];
};

const STYLES = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 36px 20px; background: #f8f7fb; color: #242034; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; }
  main { max-width: 820px; margin: 0 auto; }
  .card { background: #fff; border: 1px solid #e9e7ef; border-radius: 10px; padding: 22px 24px; margin-bottom: 18px; }
  h1 { margin: 0 0 8px; font-size: 24px; }
  h2 { margin: 0 0 12px; font-size: 17px; }
  h3 { margin: 16px 0 8px; font-size: 14px; }
  p { margin: 0 0 12px; color: #59566c; font-size: 14px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  input[type="text"], select { width: 100%; max-width: 420px; padding: 9px 11px; border: 1px solid #dad6e6; border-radius: 7px; font-size: 14px; margin-bottom: 10px; }
  button, .button-link { display: inline-block; padding: 8px 14px; border: 0; border-radius: 7px; background: #7659c8; color: #fff; font-size: 13px; font-weight: 600; text-decoration: none; cursor: pointer; }
  button.secondary { background: #efebf9; color: #4a358c; }
  button.danger { background: #c54859; color: #fff; }
  .alert { border-color: #e3b779; background: #fff8e9; color: #614114; }
  .error { border-color: #e8b6bf; background: #fff5f6; color: #8f3544; }
  .secret-url { display: block; padding: 10px 12px; margin-top: 8px; background: #242034; color: #f8f7fb; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
  .hook-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-top: 1px solid #f0edf4; }
  .hook-actions { display: flex; gap: 8px; align-items: center; }
  .hook-actions form { margin: 0; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 5px; font-size: 11px; font-weight: 600; background: #e7f5ed; color: #2d6d4e; }
  .badge.unavailable { background: #fff0e8; color: #9c4a2d; }
  .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
`;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLES}</style></head><body><main>${body}</main></body></html>`;
}

export function renderLoginPage(options: { error?: string } = {}): string {
  return layout(
    "Webhooks Admin · Sign in",
    `<div class="card">
      <h1>Incoming Webhooks Admin</h1>
      <p>Sign in with your AT Protocol account. Only active workspace admins can view or manage incoming webhooks.</p>
      ${options.error ? `<div class="card error" role="alert">${escapeHtml(options.error)}</div>` : ""}
      <form method="post" action="/admin/login">
        <label for="handle-input">AT Protocol handle or DID</label>
        <input id="handle-input" name="handle" type="text" placeholder="alice.example.com or did:plc:…" required />
        <div><button type="submit">Continue with AT Protocol</button></div>
      </form>
    </div>`,
  );
}

export function renderAuthorizeLinkPage(authorizeUrl: string, handle: string): string {
  return layout(
    "Webhooks Admin · Authorize",
    `<div class="card">
      <h1>Approve your identity</h1>
      <p>Continue to your account’s server to confirm signing in as <strong>${escapeHtml(handle)}</strong>.</p>
      <p><a class="button-link" href="${escapeHtml(authorizeUrl)}">Continue to authorization →</a></p>
    </div>`,
  );
}

export function renderErrorPage(title: string, message: string): string {
  return layout(
    title,
    `<div class="card error" role="alert">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <p><a href="/admin">Back to Webhooks Admin</a></p>
    </div>`,
  );
}

export function renderAdminDashboard(input: {
  did: string;
  csrf: string;
  workspaces: AdminWorkspaceView[];
  oneTimeHookUrl?: { hookId: string; channelName: string; url: string };
  notice?: string;
  error?: string;
}): string {
  const csrfInput = `<input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />`;
  const oneTimeBanner = input.oneTimeHookUrl
    ? `<div class="card alert" role="alert">
        <h2>Copy your webhook URL now</h2>
        <p>This URL for <strong>#${escapeHtml(input.oneTimeHookUrl.channelName)}</strong> (${escapeHtml(input.oneTimeHookUrl.hookId)}) is shown once and never stored in plaintext:</p>
        <code class="secret-url">${escapeHtml(input.oneTimeHookUrl.url)}</code>
        <p style="margin-top: 12px; margin-bottom: 0;"><a class="button-link" href="/admin">Done</a></p>
      </div>`
    : "";

  const workspaceCards = input.workspaces.map((ws) => {
    const channelOptions = ws.writableChannels
      .map(
        (ch) =>
          `<option value="${escapeHtml(ch.skey)}">${ch.visibility === "private" ? "▣" : "#"}${escapeHtml(ch.name)}</option>`,
      )
      .join("");
    const createForm = ws.writableChannels.length > 0
      ? `<form method="post" action="/admin/hooks/create">
          ${csrfInput}
          <input type="hidden" name="workspace" value="${escapeHtml(ws.uri)}" />
          <label for="channel-${escapeHtml(ws.uri)}">Channel for new webhook</label>
          <select id="channel-${escapeHtml(ws.uri)}" name="channelSkey" required>${channelOptions}</select>
          <div><button type="submit">Create webhook</button></div>
        </form>`
      : `<p>No channels in this workspace currently grant this app write access.</p>`;

    const hookRows = ws.hooks.length === 0
      ? `<p>No webhooks configured for this workspace.</p>`
      : ws.hooks
        .map((hook) => {
          const badge = hook.status === "active"
            ? `<span class="badge">active</span>`
            : `<span class="badge unavailable">unavailable${hook.unavailableReason ? ` · ${escapeHtml(hook.unavailableReason)}` : ""}</span>`;
          const actions = [
            hook.canRotate
              ? `<form method="post" action="/admin/hooks/rotate">${csrfInput}<input type="hidden" name="hookId" value="${escapeHtml(hook.id)}" /><button type="submit" class="secondary">Rotate secret</button></form>`
              : "",
            hook.canRevoke
              ? `<form method="post" action="/admin/hooks/revoke">${csrfInput}<input type="hidden" name="hookId" value="${escapeHtml(hook.id)}" /><button type="submit" class="danger">Revoke</button></form>`
              : "",
          ]
            .filter(Boolean)
            .join("");
          return `<div class="hook-row" data-hook-id="${escapeHtml(hook.id)}">
            <div>
              <strong>${hook.visibility === "private" ? "▣" : "#"}${escapeHtml(hook.channelName)}</strong>
              <code>${escapeHtml(hook.id)}</code>
              ${badge}
            </div>
            <div class="hook-actions">${actions}</div>
          </div>`;
        })
        .join("");

    return `<section class="card">
      <h2>${escapeHtml(ws.name)}</h2>
      <p>${escapeHtml(ws.uri)}</p>
      ${createForm}
      <h3>Configured webhooks</h3>
      ${hookRows}
    </section>`;
  }).join("");

  return layout(
    "Webhooks Admin",
    `<div class="topbar">
      <div><strong>Signed in as ${escapeHtml(input.did)}</strong></div>
      <form method="post" action="/admin/logout">${csrfInput}<button type="submit" class="secondary">Sign out</button></form>
    </div>
    ${input.error ? `<div class="card error" role="alert">${escapeHtml(input.error)}</div>` : ""}
    ${input.notice ? `<div class="card" role="status">${escapeHtml(input.notice)}</div>` : ""}
    ${oneTimeBanner}
    ${workspaceCards}`,
  );
}

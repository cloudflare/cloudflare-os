// A live view the agent draws in its answer, for the scripted chats and the gallery: hosting
// plans side by side, each with a button that suggests a message through `agent.send()`. It uses
// only the theme's names the agent's instructions give it.

/** The view, as the agent writes it between the tags: what the frame runs. */
export const PLANS_VIEW = `<title>Hosting plans</title>
<style>
  .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 8px; }
  .plan { display: flex; flex-direction: column; gap: 4px; padding: 12px; border-radius: 14px; background: var(--color-kumo-elevated); border: 1px solid var(--color-kumo-line); }
  .plan h3 { margin: 0; font-size: 14px; font-weight: 600; }
  .price { font-size: 20px; font-weight: 600; }
  .note { color: var(--text-color-kumo-subtle); font-size: 12px; }
  .seats { height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--color-kumo-line), transparent 30%); overflow: hidden; margin: 6px 0; }
  .seats span { display: block; height: 100%; background: var(--color-kumo-brand); border-radius: inherit; }
  .fits { color: var(--color-kumo-success); }
  button { margin-top: auto; border: 0; border-radius: 999px; padding: 7px 12px; background: var(--text-color-kumo-default); color: var(--color-kumo-base); font-weight: 500; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--color-kumo-brand); outline-offset: 2px; }
</style>
<div class="plans">
  <div class="plan">
    <h3>Starter</h3>
    <div class="price">$0</div>
    <div class="note">Up to 5 people</div>
    <div class="seats"><span style="width: 100%"></span></div>
    <div class="note">Too small for 12</div>
    <button data-plan="Starter">Choose Starter</button>
  </div>
  <div class="plan">
    <h3>Team</h3>
    <div class="price">$48<span class="note"> / month</span></div>
    <div class="note">Up to 25 people</div>
    <div class="seats"><span style="width: 48%"></span></div>
    <div class="note fits">Fits 12, room to grow</div>
    <button data-plan="Team">Choose Team</button>
  </div>
  <div class="plan">
    <h3>Business</h3>
    <div class="price">$190<span class="note"> / month</span></div>
    <div class="note">Unlimited, with SSO</div>
    <div class="seats"><span style="width: 12%"></span></div>
    <div class="note">More than you need yet</div>
    <button data-plan="Business">Choose Business</button>
  </div>
</div>
<script type="module">
  for (const button of document.querySelectorAll("button[data-plan]")) {
    button.addEventListener("click", () => agent.send(\`Let's go with the \${button.dataset.plan} plan.\`));
  }
</script>`

/** The answer the view is drawn in, as the agent writes it. */
export const PLANS_ANSWER =
  'For a team of 12, **Team** is the one that fits. Here they are side by side:\n\n' +
  `<inline-html>\n${PLANS_VIEW}\n</inline-html>\n\n` +
  'Choose one and I’ll set the workspace up on it.'

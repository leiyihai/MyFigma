import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
// @ts-ignore Shared fixture drives the real helper process.
import {fixture} from '../../../local-helper/tests/fixture.mjs';

test('a remembered pairing connects automatically and can be forgotten', async ({page}) => {
  const f = await fixture();
  const pairing = {schemaVersion: 1, address: f.base, token: f.token};
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/ui.html') return res.end(await readFile(new URL('../../dist/ui.html', import.meta.url)));
    res.end(`<script>
      window.pairing = ${JSON.stringify(pairing)};
      addEventListener('message', e => {
        const m = e.data?.pluginMessage; if (!m?.requestId || e.source !== frames[0]) return;
        const reply = result => e.source.postMessage({pluginMessage:{type:'result',requestId:m.requestId,result}},'*');
        if (m.type === 'helper-path-load') reply('');
        else if (m.type === 'helper-path-save') reply(true);
        else if (m.type === 'open-helper-folder') reply(true);
        else if (m.type === 'pairing-load') reply(window.pairing);
        else if (m.type === 'pairing-save') { window.pairing = m.pairing; reply(true); }
        else if (m.type === 'pairing-clear') { window.pairing = null; reply(true); }
        else if (m.type === 'validate') reply({valid:true,message:'空白页可导入'});
      });
    </script><iframe title="plugin" sandbox="allow-scripts" src="/ui.html" style="width:350px;height:540px"></iframe>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto('http://127.0.0.1:' + (server.address() as {port:number}).port);
    const ui = page.frameLocator('iframe');
    await expect(ui.getByTestId('connection')).toHaveText('资源助手：已连接');
    await expect(ui.locator('#pairing')).not.toBeVisible();
    expect(await ui.getByLabel('配对令牌').inputValue()).toBe(pairing.token);
    expect(await ui.locator('body').evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);

    // Connection actions and settings are separate; reconnect/forget live behind the gear.
    await ui.getByRole('button', {name:'资源助手设置', exact:true}).click();
    await expect(ui.locator('#pairing')).toBeVisible();
    await ui.getByRole('button', {name:'忘记配对', exact:true}).click();
    await expect(ui.getByLabel('配对令牌')).toHaveValue('');
    expect(await page.evaluate(() => (window as any).pairing)).toBeNull();
    await ui.getByRole('button', {name:'关闭', exact:true}).click();
    await expect(ui.locator('#pairing')).not.toBeVisible();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.cleanup();
  }
});

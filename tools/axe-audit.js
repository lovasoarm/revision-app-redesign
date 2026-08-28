
/**
 * Simple Axe-core audit runner for static site served at http://localhost:3000
 * Usage: node tools/axe-audit.js
 */
const puppeteer = require('puppeteer');
const AxePuppeteer = require('@axe-core/puppeteer').default;

(async ()=>{
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');
  const results = await new AxePuppeteer(page).analyze();
  console.log(JSON.stringify(results.violations, null, 2));
  await browser.close();
})().catch(e=>{ console.error(e); process.exit(1)});

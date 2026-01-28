#!/usr/bin/env node
/**
 * Generate screenshots from HTML reports for documentation
 */

import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPORT_DIR = process.argv[2] 
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '../reports/devops-report-2026-01-28T23-13-43');
const OUTPUT_DIR = path.join(__dirname, '../docs/images');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const pages = [
  { file: 'dashboard.html', name: 'dashboard', width: 1400, height: 1200 },
  { file: 'cicd-details.html', name: 'cicd-details', width: 1400, height: 1800 },
  { file: 'cost-details.html', name: 'cost-details', width: 1400, height: 2000 },
  { file: 'dora-details.html', name: 'dora-details', width: 1400, height: 1000 },
  { file: 'security-details.html', name: 'security-details', width: 1400, height: 1200 },
  { file: 'maturity-details.html', name: 'maturity-details', width: 1400, height: 1600 },
];

async function generateScreenshots() {
  console.log('🚀 Starting screenshot generation...');
  console.log(`📁 Report directory: ${REPORT_DIR}`);
  console.log(`📁 Output directory: ${OUTPUT_DIR}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  for (const page of pages) {
    const filePath = path.join(REPORT_DIR, page.file);
    
    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  Skipping ${page.file} - file not found`);
      continue;
    }

    console.log(`📸 Capturing ${page.file}...`);
    
    const browserPage = await browser.newPage();
    await browserPage.setViewport({ width: page.width, height: page.height });
    
    // Load the file
    await browserPage.goto(`file://${filePath}`, { waitUntil: 'networkidle0' });
    
    // Wait for charts to render
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Take full page screenshot
    await browserPage.screenshot({
      path: path.join(OUTPUT_DIR, `${page.name}.png`),
      fullPage: true,
    });
    
    // Also take a viewport screenshot for thumbnails
    await browserPage.screenshot({
      path: path.join(OUTPUT_DIR, `${page.name}-thumb.png`),
      clip: { x: 0, y: 0, width: page.width, height: 800 },
    });
    
    await browserPage.close();
    console.log(`✅ Saved ${page.name}.png`);
  }

  await browser.close();
  console.log('\n🎉 Screenshot generation complete!');
  console.log(`📁 Images saved to: ${OUTPUT_DIR}`);
}

generateScreenshots().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});

import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests/browser',workers:1,timeout:30000,use:{channel:'chrome',headless:true,trace:'off',screenshot:'off',video:'off'}});

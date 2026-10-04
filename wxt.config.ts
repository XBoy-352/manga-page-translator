import { defineConfig } from 'wxt';

// Spec §7.11: name, permissions, host_permissions; manifest_version 3 is the
// WXT default. Content-script behaviour (document_idle, all_frames: false)
// is declared on the content entrypoint itself.
export default defineConfig({
  srcDir: 'src',
  // Spec §7.11: both targets ship MV3 (WXT defaults Firefox to MV2). With MV3,
  // WXT emits the Firefox background as a non-persistent event page.
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'Manga Page Translator',
    permissions: ['storage', 'contextMenus'],
    host_permissions: ['<all_urls>'],
    icons: {
      16: '/icons/icon-16.png',
      32: '/icons/icon-32.png',
      48: '/icons/icon-48.png',
      96: '/icons/icon-96.png',
      128: '/icons/icon-128.png',
    },
    action: {
      default_title: 'Manga Page Translator',
      default_icon: {
        16: '/icons/icon-16.png',
        32: '/icons/icon-32.png',
        48: '/icons/icon-48.png',
        128: '/icons/icon-128.png',
      },
    },
    // assumption taken -- SPEC §7.11 says no gecko id is required, but AC1
    // requires `web-ext lint` to report 0 errors, and web-ext (both 8.x and
    // 10.x) reports ADDON_ID_REQUIRED for a Firefox MV3 build without one.
    // An explicit id is set on the firefox target only to satisfy AC1.
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: { id: 'manga-page-translator@xboy-352.dev' },
          },
        }
      : {}),
  }),
});

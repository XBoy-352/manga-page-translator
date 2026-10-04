// s1 scaffold stub — image swap/restore/overlay wiring lands in slice s9-shell.
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main() {},
});

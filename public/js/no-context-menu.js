// Disable the browser's default right-click context menu (Back/Forward/Reload/
// Save As/Inspect shortcuts, etc.) across the site. Note: this only removes the
// menu — it doesn't and can't block a determined user's browser devtools or
// its own menu bar; it just keeps the page from feeling like a bare webpage.
document.addEventListener('contextmenu', (e) => e.preventDefault());

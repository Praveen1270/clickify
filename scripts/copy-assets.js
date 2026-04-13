const fs   = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  copied  ${path.relative(root, src)}  →  ${path.relative(root, dest)}`);
}

// HTML files into dist so the packaged app finds them next to their JS
copy(
  path.join(root, 'src/renderer/index.html'),
  path.join(root, 'dist/renderer/index.html')
);
copy(
  path.join(root, 'src/renderer/hint.html'),
  path.join(root, 'dist/renderer/hint.html')
);
copy(
  path.join(root, 'src/renderer/settings.html'),
  path.join(root, 'dist/renderer/settings.html')
);

const iconSrc = path.join(root, 'assets/icon.png');
if (fs.existsSync(iconSrc)) {
  copy(iconSrc, path.join(root, 'dist/assets/icon.png'));
}

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const sizes = [16, 32, 64, 128, 256, 512, 1024];
const buildDir = path.join(__dirname, '..', 'build');
const iconsetDir = path.join(buildDir, 'icon.iconset');

async function generateIcons() {
  // Create iconset directory
  if (!fs.existsSync(iconsetDir)) {
    fs.mkdirSync(iconsetDir, { recursive: true });
  }

  const svgPath = path.join(buildDir, 'icon.svg');
  const svgBuffer = fs.readFileSync(svgPath);

  // Generate all required sizes for macOS iconset
  const iconSizes = [
    { size: 16, name: 'icon_16x16.png' },
    { size: 32, name: 'icon_16x16@2x.png' },
    { size: 32, name: 'icon_32x32.png' },
    { size: 64, name: 'icon_32x32@2x.png' },
    { size: 128, name: 'icon_128x128.png' },
    { size: 256, name: 'icon_128x128@2x.png' },
    { size: 256, name: 'icon_256x256.png' },
    { size: 512, name: 'icon_256x256@2x.png' },
    { size: 512, name: 'icon_512x512.png' },
    { size: 1024, name: 'icon_512x512@2x.png' },
  ];

  console.log('Generating icon PNGs...');

  for (const { size, name } of iconSizes) {
    const outputPath = path.join(iconsetDir, name);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`  Created ${name}`);
  }

  // Also create a main icon.png at 1024x1024
  await sharp(svgBuffer)
    .resize(1024, 1024)
    .png()
    .toFile(path.join(buildDir, 'icon.png'));
  console.log('  Created icon.png (1024x1024)');

  // Create 512x512 for electron-builder
  await sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(buildDir, 'icon-512.png'));

  // Create .icns using iconutil (macOS only)
  try {
    const icnsPath = path.join(buildDir, 'icon.icns');
    execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`);
    console.log('  Created icon.icns');
  } catch (err) {
    console.log('  Could not create .icns (iconutil not available or failed)');
  }

  console.log('\nIcon generation complete!');
}

generateIcons().catch(console.error);

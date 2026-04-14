// frontend/pal/storyboard_export.js
// Client-side storyboard PDF generator using jsPDF from CDN.

import { loadShot } from '/pal/static/scene_io.js';

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

export async function exportStoryboard(shotIds, viewer, onProgress) {
  const frames = [];

  for (let i = 0; i < shotIds.length; i++) {
    if (onProgress) onProgress(i + 1, shotIds.length);
    const shot = await loadShot(shotIds[i]);
    if (!shot || !shot.scene) continue;
    viewer.loadScene(shot.scene);
    await nextFrame();
    await nextFrame(); // two frames for render to settle
    const dataURL = viewer.captureFrame(1920, 1080);
    frames.push({
      shotId:      shot.shot_id,
      dataURL,
      description: shot.description || '',
      lens:        `${shot.scene?.camera?.focal_length_mm ?? '?'}mm`,
      framing:     shot.extraction?.framing ?? '',
    });
  }

  if (frames.length) buildPDF(frames);
  return frames;
}

function buildPDF(frames) {
  const { jsPDF } = window.jspdf;
  if (!jsPDF) { console.error('jsPDF not loaded'); return; }

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const cols = 3;
  const margin = 8;
  const imgW = 85;
  const imgH = 48;
  const rowH = 65;
  const pageH = 210;
  const rowsPerPage = Math.floor((pageH - margin * 2) / rowH);

  frames.forEach((frame, i) => {
    const col = i % cols;
    const rowOnPage = Math.floor((i / cols) % rowsPerPage);
    const pageBreak = i > 0 && col === 0 && rowOnPage === 0;

    if (pageBreak) doc.addPage();

    const x = margin + col * (imgW + margin);
    const y = margin + rowOnPage * rowH;

    doc.addImage(frame.dataURL, 'JPEG', x, y, imgW, imgH);

    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text(frame.shotId, x, y + imgH + 5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.text(`${frame.lens} · ${frame.framing}`, x, y + imgH + 9);

    const desc = frame.description.substring(0, 60);
    doc.text(desc, x, y + imgH + 13);
  });

  doc.save('PAL_storyboard.pdf');
}

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Upload, FileText, Wand2, Eye, Download, ChevronRight, ChevronLeft, Check, AlertTriangle, X, Plus, Trash2, GripVertical, Settings, Image as ImageIcon, RotateCcw, Sparkles, BookOpen, CheckCircle2, Circle, Square, CheckSquare, AlignLeft, List, ArrowUpDown, Hash, Loader2, Copy, FileQuestion, Lightbulb, ZapIcon, ImagePlus, Move, ZoomIn, Maximize2, Key, Zap, ClipboardList, HelpCircle, FileType, Brain, Target } from 'lucide-react';

// ============================================================================
// QUICK QUIZ - With PDF Support & Answer Key Assistant
// ============================================================================

// Generate a browser fingerprint for rate limiting
function generateClientId() {
  if (typeof window === 'undefined') return 'server';

  const stored = localStorage.getItem('quickquiz_client_id');
  if (stored) return stored;

  // Create fingerprint from browser characteristics
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('Quick Quiz', 2, 2);
  }
  const canvasHash = canvas.toDataURL().slice(-50);

  const components = [
    navigator.userAgent,
    navigator.language,
    screen.width + 'x' + screen.height,
    new Date().getTimezoneOffset(),
    canvasHash
  ].join('|');

  // Simple hash
  let hash = 0;
  for (let i = 0; i < components.length; i++) {
    hash = ((hash << 5) - hash) + components.charCodeAt(i);
    hash = hash & hash;
  }
  const clientId = 'qq_' + Math.abs(hash).toString(36);

  localStorage.setItem('quickquiz_client_id', clientId);
  return clientId;
}

const CLIENT_ID = generateClientId();

const MODEL_HAIKU = 'claude-haiku-3-5-20241022';
const MODEL_SONNET = 'claude-sonnet-4-20250514';

function selectModel(task, context = {}) {
  switch (task) {
    case 'parse': {
      const { hasImages, contentLength } = context;
      if (hasImages) return MODEL_SONNET;
      if (contentLength > 50000) return MODEL_SONNET;
      return MODEL_HAIKU;
    }
    case 'generate':
    case 'answer_key':
    default:
      return MODEL_SONNET;
  }
}

const generateId = () => Math.random().toString(36).substr(2, 9);

const QUESTION_TYPES = {
  multiple_choice: { label: 'Multiple Choice', icon: Circle, color: '#0b4901' },
  multiple_select: { label: 'Multiple Select', icon: CheckSquare, color: '#8b5cf6' },
  true_false: { label: 'True/False', icon: Check, color: '#10b981' },
  short_answer: { label: 'Short Answer', icon: AlignLeft, color: '#f59e0b' },
  essay: { label: 'Essay', icon: FileText, color: '#ec4899' },
  matching: { label: 'Matching', icon: List, color: '#06b6d4' },
  ordering: { label: 'Ordering', icon: ArrowUpDown, color: '#84cc16' },
  fill_blank: { label: 'Fill in Blank', icon: Square, color: '#f97316' },
  numerical: { label: 'Numerical', icon: Hash, color: '#6366f1' },
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function detectImageType(bytes) {
  const arr = new Uint8Array(bytes.slice(0, 12));
  if (arr[0] === 0x89 && arr[1] === 0x50 && arr[2] === 0x4E && arr[3] === 0x47) return 'image/png';
  if (arr[0] === 0xFF && arr[1] === 0xD8 && arr[2] === 0xFF) return 'image/jpeg';
  if (arr[0] === 0x47 && arr[1] === 0x49 && arr[2] === 0x46) return 'image/gif';
  if (arr[0] === 0x42 && arr[1] === 0x4D) return 'image/bmp';
  if (arr[0] === 0x52 && arr[1] === 0x49 && arr[2] === 0x46 && arr[3] === 0x46) return 'image/webp';
  return 'image/png';
}

async function extractImagesFromDocx(file) {
  const images = [];
  try {
    if (!window.JSZip) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    }
    const arrayBuffer = await file.arrayBuffer();
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const mediaFiles = [];
    zip.forEach((relativePath, zipEntry) => {
      if (relativePath.startsWith('word/media/') && !zipEntry.dir) {
        mediaFiles.push({ path: relativePath, entry: zipEntry });
      }
    });
    const imageResults = await Promise.all(mediaFiles.map(async ({ path, entry }) => {
      try {
        const imageData = await entry.async('arraybuffer');
        const mimeType = detectImageType(imageData);
        if (mimeType === 'image/emf' || mimeType === 'image/wmf') return null;
        const base64 = arrayBufferToBase64(imageData);
        const dataUrl = `data:${mimeType};base64,${base64}`;
        const dimensions = await getImageDimensions(dataUrl);
        return {
          id: generateId(),
          filename: path.split('/').pop(),
          dataUrl,
          mimeType,
          size: imageData.byteLength,
          width: dimensions.width,
          height: dimensions.height,
          source: 'docx',
        };
      } catch (imgError) {
        console.error(`Error extracting image ${path}:`, imgError);
        return null;
      }
    }));
    images.push(...imageResults.filter(Boolean));
  } catch (error) {
    console.error('Error extracting images from DOCX:', error);
  }
  return images;
}

async function extractTextFromDocx(file) {
  try {
    if (!window.JSZip) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    }
    const arrayBuffer = await file.arrayBuffer();
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    if (!documentXml) return '';
    
    // Extract text from XML, preserving paragraph breaks
    let text = documentXml
      .replace(/<w:p[^>]*>/g, '\n')  // Paragraph breaks
      .replace(/<w:br[^>]*>/g, '\n') // Line breaks
      .replace(/<w:tab[^>]*>/g, '\t') // Tabs
      .replace(/<w:t[^>]*>([^<]*)<\/w:t>/g, '$1') // Extract text content
      .replace(/<[^>]+>/g, '') // Remove remaining XML tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, '\n\n') // Normalize multiple line breaks
      .trim();
    
    return text;
  } catch (error) {
    console.error('Error extracting text from DOCX:', error);
    return '';
  }
}

// OMML to LaTeX conversion map for common elements
const OMML_TO_LATEX = {
  // Greek letters
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\epsilon',
  'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta', 'ι': '\\iota', 'κ': '\\kappa',
  'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi',
  'ρ': '\\rho', 'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\phi',
  'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda', 'Ξ': '\\Xi',
  'Π': '\\Pi', 'Σ': '\\Sigma', 'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
  // Operators
  '±': '\\pm', '×': '\\times', '÷': '\\div', '≤': '\\leq', '≥': '\\geq',
  '≠': '\\neq', '≈': '\\approx', '∞': '\\infty', '∑': '\\sum', '∏': '\\prod',
  '∫': '\\int', '∂': '\\partial', '√': '\\sqrt', '∈': '\\in', '∉': '\\notin',
  '⊂': '\\subset', '⊃': '\\supset', '∪': '\\cup', '∩': '\\cap', '∧': '\\land',
  '∨': '\\lor', '¬': '\\neg', '→': '\\rightarrow', '←': '\\leftarrow',
  '↔': '\\leftrightarrow', '⇒': '\\Rightarrow', '⇔': '\\Leftrightarrow',
};

function convertOmmlToLatex(ommlElement) {
  // Helper to get text content from a node
  const getText = (node) => node?.textContent?.trim() || '';

  // Process an OMML node recursively
  function processNode(node) {
    if (!node) return '';

    const tagName = node.tagName?.split(':').pop() || node.nodeName?.split(':').pop();

    switch (tagName) {
      case 'f': { // Fraction
        const num = node.querySelector('num') || node.getElementsByTagName('m:num')[0];
        const den = node.querySelector('den') || node.getElementsByTagName('m:den')[0];
        return `\\frac{${processChildren(num)}}{${processChildren(den)}}`;
      }
      case 'rad': { // Radical/Square root
        const deg = node.querySelector('deg') || node.getElementsByTagName('m:deg')[0];
        const e = node.querySelector('e') || node.getElementsByTagName('m:e')[0];
        const degText = processChildren(deg);
        if (degText && degText !== '2') {
          return `\\sqrt[${degText}]{${processChildren(e)}}`;
        }
        return `\\sqrt{${processChildren(e)}}`;
      }
      case 'sSup': { // Superscript
        const base = node.querySelector('e') || node.getElementsByTagName('m:e')[0];
        const sup = node.querySelector('sup') || node.getElementsByTagName('m:sup')[0];
        return `{${processChildren(base)}}^{${processChildren(sup)}}`;
      }
      case 'sSub': { // Subscript
        const base = node.querySelector('e') || node.getElementsByTagName('m:e')[0];
        const sub = node.querySelector('sub') || node.getElementsByTagName('m:sub')[0];
        return `{${processChildren(base)}}_{${processChildren(sub)}}`;
      }
      case 'sSubSup': { // Both subscript and superscript
        const base = node.querySelector('e') || node.getElementsByTagName('m:e')[0];
        const sub = node.querySelector('sub') || node.getElementsByTagName('m:sub')[0];
        const sup = node.querySelector('sup') || node.getElementsByTagName('m:sup')[0];
        return `{${processChildren(base)}}_{${processChildren(sub)}}^{${processChildren(sup)}}`;
      }
      case 'nary': { // N-ary operators (sum, product, integral)
        const chr = node.querySelector('naryPr chr')?.getAttribute('m:val') ||
                    node.querySelector('chr')?.getAttribute('val') || '∑';
        const sub = node.querySelector('sub') || node.getElementsByTagName('m:sub')[0];
        const sup = node.querySelector('sup') || node.getElementsByTagName('m:sup')[0];
        const e = node.querySelector('e') || node.getElementsByTagName('m:e')[0];
        let op = OMML_TO_LATEX[chr] || chr;
        let result = op;
        if (sub) result += `_{${processChildren(sub)}}`;
        if (sup) result += `^{${processChildren(sup)}}`;
        result += ` ${processChildren(e)}`;
        return result;
      }
      case 'd': { // Delimiters (parentheses, brackets, etc.)
        const begChr = node.querySelector('dPr begChr')?.getAttribute('m:val') ||
                       node.querySelector('begChr')?.getAttribute('val') || '(';
        const endChr = node.querySelector('dPr endChr')?.getAttribute('m:val') ||
                       node.querySelector('endChr')?.getAttribute('val') || ')';
        const e = node.querySelector('e') || node.getElementsByTagName('m:e')[0];
        const leftDelim = begChr === '(' ? '(' : begChr === '[' ? '[' : begChr === '{' ? '\\{' : begChr;
        const rightDelim = endChr === ')' ? ')' : endChr === ']' ? ']' : endChr === '}' ? '\\}' : endChr;
        return `\\left${leftDelim}${processChildren(e)}\\right${rightDelim}`;
      }
      case 'r': { // Run of text
        const text = getText(node.querySelector('t') || node.getElementsByTagName('m:t')[0] || node);
        // Convert special characters
        return text.split('').map(c => OMML_TO_LATEX[c] || c).join('');
      }
      case 't': // Text
        return getText(node).split('').map(c => OMML_TO_LATEX[c] || c).join('');
      case 'oMath': // Math container
      case 'e': // Element
      case 'num': // Numerator
      case 'den': // Denominator
      case 'sup': // Superscript content
      case 'sub': // Subscript content
      case 'deg': // Degree
        return processChildren(node);
      default:
        return processChildren(node);
    }
  }

  function processChildren(node) {
    if (!node) return '';
    let result = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 1) { // Element node
        result += processNode(child);
      } else if (child.nodeType === 3) { // Text node
        const text = child.textContent.trim();
        if (text) {
          result += text.split('').map(c => OMML_TO_LATEX[c] || c).join('');
        }
      }
    }
    return result;
  }

  return processNode(ommlElement);
}

async function extractOmmlFromDocx(file) {
  try {
    if (!window.JSZip) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    }
    const arrayBuffer = await file.arrayBuffer();
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const documentXml = await zip.file('word/document.xml')?.async('string');
    if (!documentXml) return { text: '', hasEquations: false };

    // Parse as XML to find math elements
    const parser = new DOMParser();
    const doc = parser.parseFromString(documentXml, 'text/xml');

    // Find all OMML math elements
    const mathElements = doc.getElementsByTagName('m:oMath');
    const equations = [];

    for (let i = 0; i < mathElements.length; i++) {
      const latex = convertOmmlToLatex(mathElements[i]);
      if (latex.trim()) {
        equations.push(latex.trim());
      }
    }

    // Now extract text but replace math elements with LaTeX placeholders
    let text = documentXml;

    // Replace OMML blocks with LaTeX
    let equationIndex = 0;
    text = text.replace(/<m:oMathPara[^>]*>[\s\S]*?<\/m:oMathPara>/g, () => {
      const latex = equations[equationIndex] || '';
      equationIndex++;
      return `\n$$${latex}$$\n`; // Display math
    });

    // Replace inline OMML
    equationIndex = 0;
    text = text.replace(/<m:oMath[^>]*>[\s\S]*?<\/m:oMath>/g, () => {
      const latex = equations[equationIndex] || '';
      equationIndex++;
      return ` $${latex}$ `; // Inline math
    });

    // Now clean up the rest of the XML
    text = text
      .replace(/<w:p[^>]*>/g, '\n')
      .replace(/<w:br[^>]*>/g, '\n')
      .replace(/<w:tab[^>]*>/g, '\t')
      .replace(/<w:t[^>]*>([^<]*)<\/w:t>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return {
      text,
      hasEquations: equations.length > 0,
      equationCount: equations.length
    };
  } catch (error) {
    console.error('Error extracting OMML from DOCX:', error);
    return { text: '', hasEquations: false };
  }
}

async function extractTextFromPdf(file, pageStart = null, pageEnd = null) {
  try {
    // Load PDF.js from CDN
    if (!window.pdfjsLib) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let fullText = '';
    const numPages = pdf.numPages;

    // Determine page range
    const startPage = pageStart && pageStart > 0 ? Math.min(pageStart, numPages) : 1;
    const endPage = pageEnd && pageEnd > 0 ? Math.min(pageEnd, numPages) : numPages;

    const pageNumbers = [];
    for (let i = startPage; i <= endPage; i++) {
      pageNumbers.push(i);
    }

    const pageTexts = await Promise.all(pageNumbers.map(async (pageNum) => {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Sort items by position to maintain reading order
      const items = textContent.items.sort((a, b) => {
        const yDiff = b.transform[5] - a.transform[5]; // Y position (inverted)
        if (Math.abs(yDiff) > 5) return yDiff;
        return a.transform[4] - b.transform[4]; // X position
      });

      let lastY = null;
      let pageText = '';

      for (const item of items) {
        const y = Math.round(item.transform[5]);
        if (lastY !== null && Math.abs(y - lastY) > 10) {
          pageText += '\n';
        } else if (lastY !== null && pageText && !pageText.endsWith(' ') && !pageText.endsWith('\n')) {
          pageText += ' ';
        }
        pageText += item.str;
        lastY = y;
      }

      return pageText + '\n\n--- Page ' + pageNum + ' ---\n\n';
    }));

    return pageTexts.join('').trim();
  } catch (error) {
    console.error('Error extracting text from PDF:', error);
    throw new Error('Failed to extract text from PDF. The file may be scanned or corrupted.');
  }
}

// Cache for in-flight script loading promises to handle concurrent loads
const scriptLoadPromises = {};

function loadScript(src) {
  // If we already have a promise for this script (loading or loaded), return it
  if (scriptLoadPromises[src]) {
    return scriptLoadPromises[src];
  }

  scriptLoadPromises[src] = new Promise((resolve, reject) => {
    const existingScript = document.querySelector(`script[src="${src}"]`);
    if (existingScript) {
      // Script tag exists - check if it's already loaded by testing for expected global
      if (src.includes('jszip') && window.JSZip) {
        resolve();
        return;
      }
      if (src.includes('pdf') && window.pdfjsLib) {
        resolve();
        return;
      }
      // Script tag exists but global not available - wait for it to load
      existingScript.addEventListener('load', resolve);
      existingScript.addEventListener('error', reject);
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });

  return scriptLoadPromises[src];
}

// Cache for in-flight stylesheet loading promises
const stylesheetLoadPromises = {};

function loadStylesheet(href) {
  if (stylesheetLoadPromises[href]) {
    return stylesheetLoadPromises[href];
  }

  stylesheetLoadPromises[href] = new Promise((resolve, reject) => {
    const existingLink = document.querySelector(`link[href="${href}"]`);
    if (existingLink) {
      resolve();
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = resolve;
    link.onerror = reject;
    document.head.appendChild(link);
  });

  return stylesheetLoadPromises[href];
}

// Rich text library state
let richTextLibrariesLoaded = false;
let richTextLibrariesLoading = null;

async function loadRichTextLibraries() {
  if (richTextLibrariesLoaded) return;
  if (richTextLibrariesLoading) return richTextLibrariesLoading;

  richTextLibrariesLoading = (async () => {
    // Load KaTeX CSS and JS
    await Promise.all([
      loadStylesheet('https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css'),
      loadScript('https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js'),
    ]);

    // Load marked.js for markdown
    await loadScript('https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js');

    // Load html2canvas for math-to-image export
    await loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');

    richTextLibrariesLoaded = true;
  })();

  return richTextLibrariesLoading;
}

// Render LaTeX math to an image (returns base64 PNG data URL)
async function latexToImage(latex, displayMode = false) {
  await loadRichTextLibraries();

  // Create a temporary container for rendering
  const container = document.createElement('div');
  container.style.cssText = 'position: absolute; left: -9999px; top: -9999px; background: white; padding: 8px;';
  document.body.appendChild(container);

  try {
    // Render LaTeX with KaTeX
    const html = window.katex.renderToString(latex, {
      displayMode: displayMode,
      throwOnError: false,
      output: 'html',
    });
    container.innerHTML = html;

    // Use html2canvas to capture as image
    const canvas = await window.html2canvas(container, {
      backgroundColor: null,
      scale: 2, // Higher resolution
      logging: false,
    });

    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl;
  } finally {
    document.body.removeChild(container);
  }
}

// Process text containing math and markdown for QTI export
// Returns { html: string, images: Array<{filename, dataUrl, altText}> }
async function processTextForQTI(text, imageFiles, imageCounter) {
  if (!text) return { html: '', images: [], counter: imageCounter };

  const images = [];
  let counter = imageCounter;
  let processedText = text;

  // Find and convert display math ($$...$$)
  const displayMathRegex = /\$\$([\s\S]+?)\$\$/g;
  let displayMatches = [...text.matchAll(displayMathRegex)];

  for (const match of displayMatches) {
    const latex = match[1].trim();
    try {
      const imgDataUrl = await latexToImage(latex, true);
      counter++;
      const filename = `math_${counter}.png`;
      images.push({ filename, dataUrl: imgDataUrl, mimeType: 'image/png', altText: latex });
      processedText = processedText.replace(match[0], `<p style="text-align: center;"><img src="%24IMS-CC-FILEBASE%24/${filename}" alt="${escapeXmlForQTI(latex)}" style="max-height: 100px;" /></p>`);
    } catch (e) {
      console.error('Failed to render display math:', e);
      // Keep original text if rendering fails
    }
  }

  // Find and convert inline math ($...$)
  const inlineMathRegex = /(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g;
  let inlineMatches = [...processedText.matchAll(inlineMathRegex)];

  for (const match of inlineMatches) {
    const latex = match[1].trim();
    try {
      const imgDataUrl = await latexToImage(latex, false);
      counter++;
      const filename = `math_${counter}.png`;
      images.push({ filename, dataUrl: imgDataUrl, mimeType: 'image/png', altText: latex });
      processedText = processedText.replace(match[0], `<img src="%24IMS-CC-FILEBASE%24/${filename}" alt="${escapeXmlForQTI(latex)}" style="vertical-align: middle; max-height: 1.5em;" />`);
    } catch (e) {
      console.error('Failed to render inline math:', e);
    }
  }

  // Convert basic markdown (if no complex HTML needed)
  processedText = processedText
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br />');

  return { html: processedText, images, counter };
}

// Helper for XML escaping in QTI
function escapeXmlForQTI(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Helper to check if text contains LaTeX math delimiters
function containsMath(text) {
  if (!text) return false;
  return /\$\$[\s\S]+?\$\$|\$[^\$\n]+?\$/.test(text);
}

// Helper to check if text contains markdown formatting
function containsMarkdown(text) {
  if (!text) return false;
  return /\*\*.+?\*\*|\*.+?\*|`.+?`|^#+\s|^\-\s|^\d+\.\s/m.test(text);
}

function getImageDimensions(dataUrl) {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ============================================================================
// ANSWER KEY PARSER - Handles many formats
// ============================================================================

function parseAnswerKey(input, questionCount) {
  const results = [];
  const text = input.trim().toUpperCase();
  
  if (!text) return results;
  
  // Strategy 1: Look for numbered answers like "1.B" "1-B" "1)B" "1: B"
  const numberedPattern = /(\d+)\s*[.\-\):\s]\s*([A-Z]|TRUE|FALSE|T|F)/gi;
  let matches = [...input.matchAll(numberedPattern)];
  
  if (matches.length > 0) {
    for (const match of matches) {
      const qNum = parseInt(match[1]) - 1; // 0-indexed
      let answer = match[2].toUpperCase();
      // Normalize true/false
      if (answer === 'T') answer = 'TRUE';
      if (answer === 'F') answer = 'FALSE';
      if (qNum >= 0 && qNum < questionCount) {
        results[qNum] = answer;
      }
    }
    return results;
  }
  
  // Strategy 2: Just letters/words in sequence (comma, space, or newline separated)
  const cleanText = text
    .replace(/ANSWER\s*KEY\s*:?/gi, '')
    .replace(/[^A-Z\s,\n]/g, ' ')
    .trim();
  
  // Split by common delimiters
  const parts = cleanText.split(/[\s,\n]+/).filter(p => p.length > 0);
  
  // Check if these look like answers
  const validAnswers = parts.filter(p => 
    /^[A-D]$/.test(p) || /^(TRUE|FALSE|T|F)$/.test(p)
  );
  
  if (validAnswers.length > 0) {
    for (let i = 0; i < Math.min(validAnswers.length, questionCount); i++) {
      let answer = validAnswers[i];
      if (answer === 'T') answer = 'TRUE';
      if (answer === 'F') answer = 'FALSE';
      results[i] = answer;
    }
  }
  
  return results;
}

// Apply parsed answers to quiz questions
function applyAnswerKey(quiz, answers) {
  const updatedQuestions = quiz.questions.map((q, index) => {
    const answer = answers[index];
    if (!answer) return q;
    
    if (q.type === 'true_false') {
      const isTrue = answer === 'TRUE' || answer === 'T';
      return {
        ...q,
        options: q.options.map(opt => ({
          ...opt,
          isCorrect: (opt.id === 't' && isTrue) || (opt.id === 'f' && !isTrue)
        })),
        correctAnswer: isTrue ? 't' : 'f',
        warnings: q.warnings.filter(w => w !== 'No correct answer detected'),
      };
    }
    
    if (q.type === 'multiple_choice' || q.type === 'multiple_select') {
      const answerId = answer.toLowerCase();
      const hasOption = q.options.some(opt => opt.id === answerId);
      if (hasOption) {
        return {
          ...q,
          options: q.options.map(opt => ({
            ...opt,
            isCorrect: opt.id === answerId
          })),
          correctAnswer: answerId,
          warnings: q.warnings.filter(w => w !== 'No correct answer detected'),
        };
      }
    }
    
    return q;
  });
  
  return { ...quiz, questions: updatedQuestions };
}

// ============================================================================
// LMS FORMAT PARSERS - QTI, Moodle XML, Blackboard
// ============================================================================

/**
 * Detect LMS format from XML content
 * @param {string} content - XML string
 * @param {string} fileName - Original filename
 * @returns {'qti_1.2'|'moodle_xml'|'blackboard_qti'|null}
 */
function detectLMSFormat(content, fileName) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/xml');
    const root = doc.documentElement;

    if (!root || doc.querySelector('parsererror')) {
      return null;
    }

    // Check root element
    if (root.tagName === 'questestinterop') {
      // Check for Blackboard-specific elements
      if (content.includes('bbmd_') || content.includes('bb_question_type')) {
        return 'blackboard_qti';
      }
      return 'qti_1.2';
    }

    if (root.tagName === 'quiz') {
      return 'moodle_xml';
    }

    return null;
  } catch (err) {
    console.error('Format detection error:', err);
    return null;
  }
}

/**
 * Detect format from ZIP file (IMS package)
 * @param {JSZip} zip - Loaded JSZip instance
 * @returns {Promise<{format: string, qtiContent: string, zip: JSZip}|null>}
 */
async function detectZipFormat(zip) {
  try {
    // Check for IMS manifest
    const manifestFile = zip.file('imsmanifest.xml');
    if (!manifestFile) {
      // Try looking for QTI XML directly
      const files = Object.keys(zip.files);
      const xmlFile = files.find(f => f.endsWith('.xml') && !f.includes('/'));
      if (xmlFile) {
        const content = await zip.file(xmlFile).async('string');
        const format = detectLMSFormat(content, xmlFile);
        if (format) {
          return { format, qtiContent: content, zip };
        }
      }
      return null;
    }

    const manifest = await manifestFile.async('string');
    const parser = new DOMParser();
    const doc = parser.parseFromString(manifest, 'text/xml');

    // Find QTI resource files
    const resources = doc.querySelectorAll('resource');
    for (const resource of resources) {
      const type = resource.getAttribute('type') || '';
      if (type.includes('qti') || type.includes('assessment')) {
        const fileEl = resource.querySelector('file');
        const href = fileEl?.getAttribute('href') || resource.getAttribute('href');
        if (href) {
          const qtiFile = zip.file(href);
          if (qtiFile) {
            const qtiContent = await qtiFile.async('string');
            const format = detectLMSFormat(qtiContent, href);
            if (format) {
              return { format, qtiContent, zip };
            }
          }
        }
      }
    }

    return null;
  } catch (err) {
    console.error('ZIP format detection error:', err);
    return null;
  }
}

/**
 * Strip HTML tags from content, preserving text
 */
function stripHTMLTags(html) {
  if (!html) return '';
  const temp = document.createElement('div');
  temp.innerHTML = html;
  let text = temp.textContent || temp.innerText || '';
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/**
 * Extract text from QTI mattext element (handles CDATA)
 */
function extractTextFromMattext(mattext) {
  if (!mattext) return '';
  let text = mattext.textContent || '';
  // Check for HTML content
  if (text.includes('<') && text.includes('>')) {
    text = stripHTMLTags(text);
  }
  return text.trim();
}

/**
 * Extract correct answer IDs from QTI item
 */
function extractCorrectAnswerIds(item) {
  const correctIds = [];

  // Method 1: Check respcondition with positive score
  const respconditions = item.querySelectorAll('respcondition');
  for (const rc of respconditions) {
    const setvar = rc.querySelector('setvar');
    if (setvar) {
      const varname = setvar.getAttribute('varname') || setvar.getAttribute('name') || '';
      const score = parseFloat(setvar.textContent);
      if ((varname.toUpperCase() === 'SCORE' || varname === '') && score > 0) {
        const varequal = rc.querySelector('varequal');
        if (varequal) {
          correctIds.push(varequal.textContent.trim());
        }
        // Also check for multiple correct via AND
        const varequals = rc.querySelectorAll('varequal');
        varequals.forEach(v => {
          const id = v.textContent.trim();
          if (id && !correctIds.includes(id)) {
            correctIds.push(id);
          }
        });
      }
    }
  }

  // Method 2: Check for correctresponse element (Canvas style)
  const correctResponse = item.querySelector('correctresponse');
  if (correctResponse) {
    const values = correctResponse.querySelectorAll('value');
    values.forEach(v => {
      const id = v.textContent.trim();
      if (id && !correctIds.includes(id)) {
        correctIds.push(id);
      }
    });
  }

  return [...new Set(correctIds)];
}

/**
 * Extract images from QTI content
 */
async function extractImagesFromQTI(text, item, zip) {
  const images = [];

  // Find image references in HTML content
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = imgRegex.exec(text)) !== null) {
    const src = match[1];

    if (src.startsWith('data:')) {
      // Already base64 encoded
      images.push({
        id: generateId(),
        dataUrl: src,
        filename: `image_${images.length + 1}`,
        mimeType: src.split(';')[0].split(':')[1] || 'image/png',
        source: 'qti'
      });
    } else if (zip) {
      // Try to resolve from ZIP
      // Handle IMS-CC-FILEBASE reference
      let filePath = src.replace(/%24IMS-CC-FILEBASE%24\//gi, '');
      filePath = decodeURIComponent(filePath);

      const imageFile = zip.file(filePath) || zip.file('resources/' + filePath);
      if (imageFile) {
        try {
          const imageData = await imageFile.async('arraybuffer');
          const mimeType = detectImageType(new Uint8Array(imageData)) || 'image/png';
          const base64 = arrayBufferToBase64(imageData);
          images.push({
            id: generateId(),
            filename: filePath.split('/').pop(),
            dataUrl: `data:${mimeType};base64,${base64}`,
            mimeType,
            source: 'qti'
          });
        } catch (e) {
          console.warn('Failed to extract image:', filePath, e);
        }
      }
    }
  }

  return images;
}

/**
 * Parse a single QTI item element into a question
 */
async function parseQTIItem(item, index, zip) {
  try {
    // Get question type from metadata
    const metadataFields = item.querySelectorAll('qtimetadatafield');
    let qtiType = 'multiple_choice_question';
    let points = 1;

    for (const field of metadataFields) {
      const label = field.querySelector('fieldlabel')?.textContent?.trim();
      const entry = field.querySelector('fieldentry')?.textContent?.trim();
      if (label === 'question_type') qtiType = entry;
      if (label === 'points_possible') points = parseFloat(entry) || 1;
    }

    // Map QTI types to Quick Quiz types
    const typeMap = {
      'multiple_choice_question': 'multiple_choice',
      'true_false_question': 'true_false',
      'short_answer_question': 'short_answer',
      'essay_question': 'essay',
      'matching_question': 'matching',
      'multiple_answers_question': 'multiple_select',
      'fill_in_multiple_blanks_question': 'fill_blank',
      'numerical_question': 'numerical',
      'calculated_question': 'numerical',
      'text_only_question': 'essay'
    };

    const type = typeMap[qtiType] || 'multiple_choice';

    // Extract question text
    const mattext = item.querySelector('presentation > material > mattext') ||
                    item.querySelector('material > mattext');
    let text = extractTextFromMattext(mattext);

    // Extract images
    const rawText = mattext?.textContent || '';
    const images = await extractImagesFromQTI(rawText, item, zip);

    // Clean image tags from text
    text = text.replace(/<img[^>]*>/gi, '').trim();

    // Extract options for choice questions
    let options = [];
    let correctAnswer = null;

    if (type === 'multiple_choice' || type === 'true_false' || type === 'multiple_select') {
      const responseLabels = item.querySelectorAll('response_label');
      const correctIds = extractCorrectAnswerIds(item);

      options = [...responseLabels].map((label, i) => {
        const id = label.getAttribute('ident') || String.fromCharCode(97 + i);
        const optionText = extractTextFromMattext(label.querySelector('mattext'));
        const isCorrect = correctIds.includes(id);
        if (isCorrect && !correctAnswer) correctAnswer = id;

        return { id, text: optionText, isCorrect };
      });

      // For true/false, ensure proper IDs
      if (type === 'true_false' && options.length === 2) {
        options = options.map(opt => {
          const lower = opt.text.toLowerCase();
          if (lower === 'true' || lower === 't') {
            return { ...opt, id: 't' };
          } else if (lower === 'false' || lower === 'f') {
            return { ...opt, id: 'f' };
          }
          return opt;
        });
        correctAnswer = options.find(o => o.isCorrect)?.id || null;
      }
    }

    return {
      id: `q${index + 1}`,
      type,
      text,
      points,
      options,
      correctAnswer,
      images,
      confidence: 95,
      warnings: []
    };
  } catch (err) {
    console.error('Error parsing QTI item:', err);
    return null;
  }
}

/**
 * Parse QTI 1.2 XML into Quick Quiz quiz format
 */
async function parseQTI12(xmlContent, zip = null) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlContent, 'text/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error('Invalid XML format');
    }

    const assessment = doc.querySelector('assessment');
    const title = assessment?.getAttribute('title') || 'Imported QTI Quiz';

    const items = doc.querySelectorAll('item');
    const questions = [];

    for (let i = 0; i < items.length; i++) {
      const question = await parseQTIItem(items[i], i, zip);
      if (question) questions.push(question);
    }

    return {
      id: generateId(),
      title,
      description: 'Imported from QTI file',
      questions,
      warnings: [],
      metadata: {
        sourceType: 'qti',
        sourceFile: 'QTI Import',
        createdAt: new Date().toISOString(),
        parseConfidence: 95,
        imageCount: questions.reduce((sum, q) => sum + (q.images?.length || 0), 0),
        answerKeyFound: true
      }
    };
  } catch (err) {
    console.error('QTI parsing error:', err);
    return {
      id: generateId(),
      title: 'Import Error',
      description: 'Failed to parse QTI file: ' + err.message,
      questions: [],
      warnings: ['Import failed: ' + err.message],
      metadata: { sourceType: 'qti', parseConfidence: 0 }
    };
  }
}

/**
 * Parse Moodle XML format into Quick Quiz quiz format
 */
async function parseMoodleXML(xmlContent) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlContent, 'text/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error('Invalid XML format');
    }

    const questionElements = doc.querySelectorAll('question');
    const questions = [];
    let index = 0;

    for (const qEl of questionElements) {
      const qType = qEl.getAttribute('type');

      // Skip category and description types
      if (qType === 'category' || qType === 'description') continue;

      const typeMap = {
        'multichoice': 'multiple_choice',
        'truefalse': 'true_false',
        'shortanswer': 'short_answer',
        'essay': 'essay',
        'matching': 'matching',
        'numerical': 'numerical',
        'cloze': 'fill_blank',
        'multianswer': 'fill_blank'
      };

      const type = typeMap[qType] || 'multiple_choice';

      // Extract question text
      const questionText = qEl.querySelector('questiontext > text')?.textContent || '';
      const nameText = qEl.querySelector('name > text')?.textContent || '';
      let text = stripHTMLTags(questionText) || nameText;

      // Extract points
      const defaultGrade = parseFloat(qEl.querySelector('defaultgrade')?.textContent) || 1;

      // Extract options and correct answer
      let options = [];
      let correctAnswer = null;

      if (type === 'multiple_choice' || type === 'true_false') {
        const answers = qEl.querySelectorAll('answer');
        options = [...answers].map((ans, i) => {
          const fraction = parseFloat(ans.getAttribute('fraction')) || 0;
          const id = String.fromCharCode(97 + i);
          const isCorrect = fraction > 0;
          if (isCorrect && !correctAnswer) correctAnswer = id;

          return {
            id,
            text: stripHTMLTags(ans.querySelector('text')?.textContent || ''),
            isCorrect
          };
        });

        // Fix true/false IDs
        if (type === 'true_false') {
          options = options.map(opt => {
            const lower = opt.text.toLowerCase();
            if (lower === 'true' || lower === 't') return { ...opt, id: 't' };
            if (lower === 'false' || lower === 'f') return { ...opt, id: 'f' };
            return opt;
          });
          correctAnswer = options.find(o => o.isCorrect)?.id || null;
        }
      }

      questions.push({
        id: `q${++index}`,
        type,
        text,
        points: defaultGrade,
        options,
        correctAnswer,
        images: [],
        confidence: 90,
        warnings: []
      });
    }

    return {
      id: generateId(),
      title: 'Imported Moodle Quiz',
      description: 'Imported from Moodle XML format',
      questions,
      warnings: [],
      metadata: {
        sourceType: 'moodle',
        sourceFile: 'Moodle Import',
        createdAt: new Date().toISOString(),
        parseConfidence: 90,
        imageCount: 0,
        answerKeyFound: true
      }
    };
  } catch (err) {
    console.error('Moodle parsing error:', err);
    return {
      id: generateId(),
      title: 'Import Error',
      description: 'Failed to parse Moodle file: ' + err.message,
      questions: [],
      warnings: ['Import failed: ' + err.message],
      metadata: { sourceType: 'moodle', parseConfidence: 0 }
    };
  }
}

/**
 * Parse Blackboard QTI variant into Quick Quiz quiz format
 */
async function parseBlackboardQTI(xmlContent, zip = null) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlContent, 'text/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error('Invalid XML format');
    }

    const assessment = doc.querySelector('assessment');
    const title = assessment?.getAttribute('title') || 'Imported Blackboard Quiz';

    const items = doc.querySelectorAll('item');
    const questions = [];

    // Blackboard type mapping
    const bbTypeMap = {
      'Multiple Choice': 'multiple_choice',
      'True/False': 'true_false',
      'Short Response': 'short_answer',
      'Essay': 'essay',
      'Matching': 'matching',
      'Fill in the Blank': 'fill_blank',
      'Numeric': 'numerical',
      'Multiple Answer': 'multiple_select'
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Get Blackboard-specific type
      const bbType = item.querySelector('bbmd_questiontype')?.textContent || '';
      const type = bbTypeMap[bbType] || 'multiple_choice';

      // Extract question text
      const mattext = item.querySelector('presentation > flow > material > mat_extension > mat_formattedtext') ||
                      item.querySelector('material > mattext');
      let text = extractTextFromMattext(mattext);

      // Extract images
      const rawText = mattext?.textContent || '';
      const images = await extractImagesFromQTI(rawText, item, zip);
      text = text.replace(/<img[^>]*>/gi, '').trim();

      // Get points
      const pointsEl = item.querySelector('bbmd_asi_object_id')?.nextElementSibling;
      const points = parseFloat(item.querySelector('qmd_absolutescore_max')?.textContent) || 1;

      // Extract options
      let options = [];
      let correctAnswer = null;

      if (type === 'multiple_choice' || type === 'true_false' || type === 'multiple_select') {
        const responseLabels = item.querySelectorAll('response_label');
        const correctIds = extractCorrectAnswerIds(item);

        options = [...responseLabels].map((label, idx) => {
          const id = label.getAttribute('ident') || String.fromCharCode(97 + idx);
          const optMattext = label.querySelector('mat_formattedtext') || label.querySelector('mattext');
          const optionText = extractTextFromMattext(optMattext);
          const isCorrect = correctIds.includes(id);
          if (isCorrect && !correctAnswer) correctAnswer = id;

          return { id, text: optionText, isCorrect };
        });
      }

      questions.push({
        id: `q${i + 1}`,
        type,
        text,
        points,
        options,
        correctAnswer,
        images,
        confidence: 88,
        warnings: []
      });
    }

    return {
      id: generateId(),
      title,
      description: 'Imported from Blackboard',
      questions,
      warnings: [],
      metadata: {
        sourceType: 'blackboard',
        sourceFile: 'Blackboard Import',
        createdAt: new Date().toISOString(),
        parseConfidence: 88,
        imageCount: questions.reduce((sum, q) => sum + (q.images?.length || 0), 0),
        answerKeyFound: true
      }
    };
  } catch (err) {
    console.error('Blackboard parsing error:', err);
    return {
      id: generateId(),
      title: 'Import Error',
      description: 'Failed to parse Blackboard file: ' + err.message,
      questions: [],
      warnings: ['Import failed: ' + err.message],
      metadata: { sourceType: 'blackboard', parseConfidence: 0 }
    };
  }
}

/**
 * Merge multiple quizzes into one
 */
function mergeQuizzes(primaryQuiz, importedQuizzes) {
  if (importedQuizzes.length === 0 && primaryQuiz) {
    return primaryQuiz;
  }

  if (!primaryQuiz && importedQuizzes.length === 1) {
    return importedQuizzes[0];
  }

  if (!primaryQuiz && importedQuizzes.length === 0) {
    return null;
  }

  // Combine all quizzes
  const allQuizzes = primaryQuiz
    ? [primaryQuiz, ...importedQuizzes]
    : importedQuizzes;

  // Re-number questions
  let questionIndex = 0;
  const allQuestions = allQuizzes.flatMap(quiz =>
    quiz.questions.map(q => ({
      ...q,
      id: `q${++questionIndex}`
    }))
  );

  // Use first quiz as base
  const baseQuiz = allQuizzes[0];

  return {
    id: generateId(),
    title: allQuizzes.length > 1 ? 'Combined Quiz' : baseQuiz.title,
    description: allQuizzes.length > 1
      ? `Combined from ${allQuizzes.length} sources`
      : baseQuiz.description,
    questions: allQuestions,
    warnings: allQuizzes.flatMap(q => q.warnings || []),
    metadata: {
      sourceType: allQuizzes.length > 1 ? 'merged' : baseQuiz.metadata?.sourceType,
      sourceCount: allQuizzes.length,
      createdAt: new Date().toISOString(),
      parseConfidence: Math.round(
        allQuizzes.reduce((sum, q) => sum + (q.metadata?.parseConfidence || 80), 0) / allQuizzes.length
      ),
      imageCount: allQuestions.reduce((sum, q) => sum + (q.images?.length || 0), 0),
      answerKeyFound: allQuizzes.some(q => q.metadata?.answerKeyFound)
    }
  };
}

// ============================================================================
// MAIN APP COMPONENT
// ============================================================================

export default function QuickQuiz() {
  const [currentStep, setCurrentStep] = useState(0);
  const [quiz, setQuiz] = useState(null);
  const [selectedQuestionIndex, setSelectedQuestionIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [processingStatus, setProcessingStatus] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [extractedContents, setExtractedContents] = useState([]); // { file, text, images, fileType, parsedQuiz }
  const [importedQuizzes, setImportedQuizzes] = useState([]); // Pre-parsed LMS quizzes
  const [textInput, setTextInput] = useState('');
  const [showTextInput, setShowTextInput] = useState(false);
  const [apiKey] = useState('embedded'); // Using embedded API key with rate limiting
  const [showAnswerKeyModal, setShowAnswerKeyModal] = useState(false);
  const [error, setError] = useState(null);
  const [rateLimitInfo, setRateLimitInfo] = useState({ limit: 10, remaining: 10 });
  const [rateLimitError, setRateLimitError] = useState(null);
  const [exportFormat, setExportFormat] = useState('qti');
  const [extractedImages, setExtractedImages] = useState([]);
  const [extractedText, setExtractedText] = useState('');
  const [imagePreview, setImagePreview] = useState(null);
  const [fileType, setFileType] = useState(null);
  const [quizSettings, setQuizSettings] = useState({
    title: '',
    description: '',
    timeLimit: 0,
    allowBacktrack: true,
    showResults: 'after_submission',
    attemptsAllowed: 1,
  });

  // Quiz Generator Mode State
  const [mode, setMode] = useState('parse'); // 'parse' | 'generate'
  const [generationConfig, setGenerationConfig] = useState({
    questionTypes: {
      multiple_choice: 4,
      true_false: 3,
      short_answer: 2,
      essay: 1,
      matching: 0,
      ordering: 0,
      fill_blank: 0,
      numerical: 0
    },
    difficulty: 'medium', // 'easy' | 'medium' | 'hard' | 'mixed'
    bloomsLevels: ['remember', 'understand'],
    includeExplanations: true,
    distractorQuality: 'plausible' // 'plausible' | 'very_plausible' | 'common_misconceptions'
  });
  const [pageRange, setPageRange] = useState({ start: '', end: '' });

  const fileInputRef = useRef(null);

  // API proxy that uses embedded key with rate limiting
  const callAnthropicProxy = async (body) => {
    const response = await fetch('/api/anthropic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-ID': CLIENT_ID,
      },
      body: JSON.stringify(body)
    });

    // Update rate limit info from headers
    const limit = parseInt(response.headers.get('X-RateLimit-Limit') || '10');
    const remaining = parseInt(response.headers.get('X-RateLimit-Remaining') || '0');
    setRateLimitInfo({ limit, remaining });

    if (response.status === 429) {
      const errorData = await response.json();
      setRateLimitError(errorData.error?.message || 'Daily limit reached. Please try again tomorrow.');
      throw new Error(errorData.error?.message || 'Rate limit exceeded');
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'API request failed');
    }

    return response.json();
  };

  const steps = [
    { id: 0, label: 'Upload', icon: Upload },
    { id: 1, label: 'Processing', icon: Wand2 },
    { id: 2, label: 'Edit', icon: FileText },
    { id: 3, label: 'Settings', icon: Settings },
    { id: 4, label: 'Preview', icon: Eye },
    { id: 5, label: 'Export', icon: Download },
  ];

  // Count questions needing answers
  const questionsNeedingAnswers = quiz?.questions.filter(q => 
    ['multiple_choice', 'multiple_select', 'true_false'].includes(q.type) &&
    !q.options?.some(opt => opt.isCorrect)
  ).length || 0;

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files?.length > 0) {
      handleFilesSelect(Array.from(files));
    }
  }, []);

  const handleFilesSelect = async (newFiles) => {
    if (!newFiles || newFiles.length === 0) return;

    // Filter valid files (including LMS formats)
    const validFiles = newFiles.filter(file => {
      const name = file.name.toLowerCase();
      return name.endsWith('.pdf') || name.endsWith('.docx') ||
             name.endsWith('.txt') || name.endsWith('.xml') ||
             name.endsWith('.zip') || file.type === 'application/pdf' ||
             file.type === 'text/plain' || file.type === 'text/xml' ||
             file.type === 'application/xml' || file.type === 'application/zip';
    });

    if (validFiles.length === 0) {
      setError('Please upload PDF, Word (.docx), text, QTI (.xml), or LMS package (.zip) files.');
      return;
    }

    // Add to existing files (no duplicates by name)
    const existingNames = uploadedFiles.map(f => f.name);
    const uniqueNewFiles = validFiles.filter(f => !existingNames.includes(f.name));

    if (uniqueNewFiles.length === 0) {
      setError('These files have already been added.');
      return;
    }

    const allFiles = [...uploadedFiles, ...uniqueNewFiles];
    setUploadedFiles(allFiles);
    setError(null);

    // Extract content from new files
    setProcessingStatus(`Processing ${uniqueNewFiles.length} file(s)...`);

    try {
      const newContents = await Promise.all(uniqueNewFiles.map(async (file) => {
        const fileName = file.name.toLowerCase();

        // Determine file type
        let fileType = 'txt';
        if (fileName.endsWith('.pdf')) fileType = 'pdf';
        else if (fileName.endsWith('.docx')) fileType = 'docx';
        else if (fileName.endsWith('.xml')) fileType = 'lms_xml';
        else if (fileName.endsWith('.zip')) fileType = 'lms_zip';

        let text = '';
        let images = [];
        let parsedQuiz = null;

        if (fileType === 'txt') {
          text = await file.text();
        } else if (fileType === 'docx') {
          [text, images] = await Promise.all([
            extractTextFromDocx(file),
            extractImagesFromDocx(file)
          ]);
        } else if (fileType === 'pdf') {
          text = await extractTextFromPdf(file);
        } else if (fileType === 'lms_xml') {
          // Parse XML LMS format
          const xmlContent = await file.text();
          const format = detectLMSFormat(xmlContent, file.name);

          if (format === 'qti_1.2') {
            parsedQuiz = await parseQTI12(xmlContent);
          } else if (format === 'moodle_xml') {
            parsedQuiz = await parseMoodleXML(xmlContent);
          } else if (format === 'blackboard_qti') {
            parsedQuiz = await parseBlackboardQTI(xmlContent);
          }

          if (parsedQuiz && parsedQuiz.questions.length > 0) {
            text = `[LMS Quiz: ${parsedQuiz.title}]\n${parsedQuiz.questions.length} questions imported`;
            images = parsedQuiz.questions.flatMap(q => q.images || []);
          } else {
            // Not a recognized LMS format, treat as plain text
            text = xmlContent;
            fileType = 'txt';
          }
        } else if (fileType === 'lms_zip') {
          // Parse ZIP IMS package
          if (!window.JSZip) {
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
          }
          const arrayBuffer = await file.arrayBuffer();
          const zip = await window.JSZip.loadAsync(arrayBuffer);
          const detected = await detectZipFormat(zip);

          if (detected) {
            if (detected.format === 'qti_1.2') {
              parsedQuiz = await parseQTI12(detected.qtiContent, detected.zip);
            } else if (detected.format === 'blackboard_qti') {
              parsedQuiz = await parseBlackboardQTI(detected.qtiContent, detected.zip);
            } else if (detected.format === 'moodle_xml') {
              parsedQuiz = await parseMoodleXML(detected.qtiContent);
            }

            if (parsedQuiz && parsedQuiz.questions.length > 0) {
              text = `[LMS Package: ${parsedQuiz.title}]\n${parsedQuiz.questions.length} questions imported`;
              images = parsedQuiz.questions.flatMap(q => q.images || []);
            }
          }

          if (!parsedQuiz) {
            setError(`Could not parse LMS package: ${file.name}`);
          }
        }

        return { file, text, images, fileType, parsedQuiz };
      }));

      // Update extracted contents
      const updatedContents = [...extractedContents, ...newContents];
      setExtractedContents(updatedContents);

      // Collect new parsed quizzes
      const newParsedQuizzes = newContents
        .filter(c => c.parsedQuiz && c.parsedQuiz.questions.length > 0)
        .map(c => c.parsedQuiz);

      if (newParsedQuizzes.length > 0) {
        setImportedQuizzes(prev => [...prev, ...newParsedQuizzes]);
      }

      // Concatenate all text (excluding LMS placeholder text for combined view)
      const textContents = updatedContents.filter(c => !c.text.startsWith('[LMS'));
      const combinedText = textContents.length > 0
        ? textContents.map(c => `--- ${c.file.name} ---\n${c.text}`).join('\n\n')
        : '';
      setExtractedText(combinedText);
      setTextInput(combinedText);

      // Combine all images
      const allImages = updatedContents.flatMap(c => c.images || []);
      setExtractedImages(allImages);

      // Set file type based on first non-LMS file
      const firstNonLMS = updatedContents.find(c => !c.fileType.startsWith('lms'));
      if (firstNonLMS) {
        setFileType(firstNonLMS.fileType);
      } else if (updatedContents.length > 0) {
        setFileType(updatedContents[0].fileType);
      }

      setProcessingStatus('');
    } catch (err) {
      setError(err.message || 'Failed to process files.');
      setProcessingStatus('');
    }
  };

  const removeFile = (fileName) => {
    setUploadedFiles(prev => prev.filter(f => f.name !== fileName));
    setExtractedContents(prev => {
      const updated = prev.filter(c => c.file.name !== fileName);

      // Also remove any parsed quiz from this file
      const removedContent = prev.find(c => c.file.name === fileName);
      if (removedContent?.parsedQuiz) {
        setImportedQuizzes(prevQuizzes =>
          prevQuizzes.filter(q => q.id !== removedContent.parsedQuiz.id)
        );
      }

      // Recalculate combined text (excluding LMS placeholder text)
      const textContents = updated.filter(c => !c.text.startsWith('[LMS'));
      if (textContents.length > 0) {
        const combinedText = textContents.map(c =>
          `--- ${c.file.name} ---\n${c.text}`
        ).join('\n\n');
        setExtractedText(combinedText);
        setTextInput(combinedText);
      } else {
        setExtractedText('');
        setTextInput('');
      }

      setExtractedImages(updated.flatMap(c => c.images || []));

      const firstNonLMS = updated.find(c => !c.fileType?.startsWith('lms'));
      if (firstNonLMS) {
        setFileType(firstNonLMS.fileType);
      } else if (updated.length > 0) {
        setFileType(updated[0].fileType);
      } else {
        setFileType(null);
      }

      return updated;
    });
  };

  const clearAllFiles = () => {
    setUploadedFiles([]);
    setExtractedContents([]);
    setImportedQuizzes([]);
    setExtractedText('');
    setTextInput('');
    setExtractedImages([]);
    setFileType(null);
  };

  const processQuiz = async (content) => {
    setCurrentStep(1);
    setIsProcessing(true);
    setProcessingProgress(0);
    setProcessingStatus('Initializing...');

    // Check if we only have imported LMS quizzes (no text content to parse)
    const hasTextContent = content && content.trim().length > 0;
    const hasImportedQuizzes = importedQuizzes.length > 0;

    if (!hasTextContent && hasImportedQuizzes) {
      // Only imported quizzes, skip AI parsing
      setProcessingProgress(50);
      setProcessingStatus('Merging imported quizzes...');

      await new Promise(resolve => setTimeout(resolve, 500));

      const mergedQuiz = mergeQuizzes(null, importedQuizzes);

      setProcessingProgress(100);
      setProcessingStatus('Complete!');

      setTimeout(() => {
        setQuiz(mergedQuiz);
        setQuizSettings(prev => ({
          ...prev,
          title: mergedQuiz.title || 'Imported Quiz',
          description: mergedQuiz.description || '',
        }));
        setIsProcessing(false);
        setCurrentStep(2);
      }, 500);
      return;
    }

    try {
      const stages = [
        { progress: 10, status: 'Reading document...' },
        { progress: 20, status: 'Extracting images...' },
        { progress: 35, status: 'Analyzing structure...' },
        { progress: 50, status: 'Detecting question types...' },
        { progress: 65, status: 'Extracting questions...' },
        { progress: 75, status: 'Looking for answer key...' },
        { progress: 85, status: 'Associating images...' },
        { progress: 95, status: 'Validating results...' },
        { progress: 100, status: 'Complete!' },
      ];

      if (apiKey) {
        setProcessingStatus('Connecting to AI...');
        setProcessingProgress(15);
        setRateLimitError(null);

        let imageContext = '';
        if (extractedImages.length > 0) {
          imageContext = `\n\nNOTE: This document contains ${extractedImages.length} embedded images. They are referenced as [IMAGE_1], [IMAGE_2], etc. When you detect that a question references an image, include an "imageRefs" array with the image numbers.`;
        }

        const parseModel = selectModel('parse', {
          hasImages: extractedImages.length > 0,
          contentLength: content.length,
        });

        const data = await callAnthropicProxy({
          model: parseModel,
          max_tokens: 8000,
          messages: [
            {
              role: 'user',
              content: `You are a quiz parsing assistant. Parse the following quiz content and extract structured data.

IMPORTANT: Look for an answer key in the document. It might be at the end, labeled "Answer Key", "Answers", or just a list like "1-B, 2-A, 3-C". If you find answers, mark the correct options.

Handle inconsistent formatting gracefully:
- Questions may be numbered as 1., 1), A., a), etc.
- Answer choices may use various markers
- Question types: multiple_choice, multiple_select, true_false, short_answer, essay, matching, fill_blank
${imageContext}

Output ONLY valid JSON in this format:
{
  "title": "Quiz Title",
  "description": "Instructions if found",
  "questions": [
    {
      "id": "q1",
      "type": "multiple_choice",
      "text": "Question text",
      "points": 1,
      "options": [
        {"id": "a", "text": "Option A", "isCorrect": false},
        {"id": "b", "text": "Option B", "isCorrect": true}
      ],
      "correctAnswer": "b",
      "confidence": 95,
      "warnings": [],
      "imageRefs": []
    }
  ],
  "answerKeyFound": true,
  "warnings": []
}

For true_false: options should be [{"id": "t", "text": "True", "isCorrect": ?}, {"id": "f", "text": "False", "isCorrect": ?}]
Confidence: 0-100 indicating parsing confidence.
answerKeyFound: true if you found and applied an answer key.

QUIZ CONTENT:
---
${content}
---`
            }
          ]
        });

        setProcessingProgress(70);
        setProcessingStatus('Processing AI response...');
        const aiResponse = data.content[0].text;
        
        let parsedQuiz;
        try {
          const jsonMatch = aiResponse.match(/```json\s*([\s\S]*?)\s*```/) || 
                           aiResponse.match(/```\s*([\s\S]*?)\s*```/);
          const jsonStr = jsonMatch ? jsonMatch[1] : aiResponse;
          parsedQuiz = JSON.parse(jsonStr.trim());
        } catch {
          parsedQuiz = JSON.parse(aiResponse);
        }

        setProcessingProgress(90);
        setProcessingStatus('Associating images...');
        
        parsedQuiz.questions = parsedQuiz.questions.map(q => {
          const images = [];
          if (q.imageRefs && Array.isArray(q.imageRefs)) {
            q.imageRefs.forEach(refNum => {
              const imgIndex = refNum - 1;
              if (extractedImages[imgIndex]) {
                images.push({ ...extractedImages[imgIndex], id: generateId() });
              }
            });
          }
          return { ...q, images, imageRefs: undefined };
        });

        setProcessingProgress(100);
        setProcessingStatus('Complete!');

        setTimeout(() => {
          const aiQuiz = {
            ...parsedQuiz,
            id: generateId(),
            metadata: {
              sourceType: fileType || 'text',
              sourceFile: uploadedFiles.length > 0 ? uploadedFiles[0].name : 'Text Input',
              createdAt: new Date().toISOString(),
              parseConfidence: Math.round(
                parsedQuiz.questions.reduce((acc, q) => acc + (q.confidence || 80), 0) /
                parsedQuiz.questions.length
              ),
              imageCount: extractedImages.length,
              answerKeyFound: parsedQuiz.answerKeyFound || false,
            }
          };

          // Merge with imported quizzes if any
          const finalQuiz = hasImportedQuizzes ? mergeQuizzes(aiQuiz, importedQuizzes) : aiQuiz;

          setQuiz(finalQuiz);
          setQuizSettings(prev => ({
            ...prev,
            title: finalQuiz.title || 'Untitled Quiz',
            description: finalQuiz.description || '',
          }));
          setIsProcessing(false);
          setCurrentStep(2);
        }, 500);

      } else {
        // Demo mode
        for (let i = 0; i < stages.length; i++) {
          await new Promise(resolve => setTimeout(resolve, 350));
          setProcessingProgress(stages[i].progress);
          setProcessingStatus(stages[i].status);
        }

        const demoQuiz = parseDemoQuiz(content);

        // Merge with imported quizzes if any
        const finalQuiz = hasImportedQuizzes ? mergeQuizzes(demoQuiz, importedQuizzes) : demoQuiz;

        setTimeout(() => {
          setQuiz(finalQuiz);
          setQuizSettings(prev => ({
            ...prev,
            title: finalQuiz.title || 'Untitled Quiz',
            description: finalQuiz.description || '',
          }));
          setIsProcessing(false);
          setCurrentStep(2);
        }, 500);
      }
      
    } catch (err) {
      console.error('Processing error:', err);
      setError('Failed to process quiz. Please try again or check your API key.');
      setIsProcessing(false);
      setCurrentStep(0);
    }
  };

  const parseDemoQuiz = (content) => {
    const questions = [];
    const lines = content.split('\n').filter(l => l.trim());
    
    let currentQuestion = null;
    let questionNumber = 0;
    
    // Look for answer key in content
    const answerKeyMatch = content.match(/answer\s*key\s*:?\s*(.+)/i);
    let foundAnswers = [];
    if (answerKeyMatch) {
      foundAnswers = parseAnswerKey(answerKeyMatch[1], 100);
    }
    
    const titleMatch = content.match(/^(.+?)(Test|Quiz|Exam)/i);
    const title = titleMatch ? titleMatch[0].trim() : 'Imported Quiz';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Skip answer key section
      if (/answer\s*key/i.test(line)) continue;
      
      const questionMatch = line.match(/^(\d+)[.)]\s*(.+)/);
      if (questionMatch) {
        if (currentQuestion) questions.push(currentQuestion);
        questionNumber++;
        const questionText = questionMatch[2];
        
        let type = 'multiple_choice';
        if (/true\s*(\/|or)\s*false/i.test(questionText)) type = 'true_false';
        else if (/short answer|briefly|explain/i.test(questionText)) type = 'short_answer';
        else if (/essay|describe|discuss/i.test(questionText)) type = 'essay';
        else if (/match/i.test(questionText)) type = 'matching';
        else if (/fill in|blank|_____/i.test(questionText)) type = 'fill_blank';
        
        currentQuestion = {
          id: `q${questionNumber}`,
          type,
          text: questionText,
          points: type === 'essay' ? 10 : type === 'short_answer' ? 5 : 2,
          options: [],
          correctAnswer: null,
          confidence: 85 + Math.floor(Math.random() * 15),
          warnings: [],
          images: [],
        };
        
        if (type === 'true_false') {
          const answer = foundAnswers[questionNumber - 1];
          const isTrue = answer === 'TRUE';
          const isFalse = answer === 'FALSE';
          currentQuestion.options = [
            { id: 't', text: 'True', isCorrect: isTrue },
            { id: 'f', text: 'False', isCorrect: isFalse },
          ];
          if (isTrue || isFalse) {
            currentQuestion.correctAnswer = isTrue ? 't' : 'f';
          }
        }
        continue;
      }
      
      const optionMatch = line.match(/^([A-Da-d])[.)]\s*(.+)/);
      if (optionMatch && currentQuestion && currentQuestion.type === 'multiple_choice') {
        const optId = optionMatch[1].toLowerCase();
        const answer = foundAnswers[questionNumber - 1];
        const isCorrect = answer && answer.toLowerCase() === optId;
        currentQuestion.options.push({
          id: optId,
          text: optionMatch[2],
          isCorrect,
        });
        if (isCorrect) {
          currentQuestion.correctAnswer = optId;
        }
      }
    }
    
    if (currentQuestion) questions.push(currentQuestion);
    
    // Add warnings
    questions.forEach(q => {
      if (['multiple_choice', 'multiple_select', 'true_false'].includes(q.type) && 
          !q.options.some(o => o.isCorrect)) {
        q.warnings.push('No correct answer detected');
      }
      if (q.type === 'multiple_choice' && q.options.length < 2) {
        q.warnings.push('Fewer than 2 answer options');
      }
    });
    
    return {
      id: generateId(),
      title,
      description: 'Imported quiz - please review and verify all questions.',
      questions,
      warnings: questions.length === 0 ? ['No questions detected'] : [],
      metadata: {
        sourceType: fileType || 'text',
        sourceFile: uploadedFile?.name || 'Text Input',
        createdAt: new Date().toISOString(),
        parseConfidence: questions.length > 0
          ? Math.round(questions.reduce((acc, q) => acc + q.confidence, 0) / questions.length)
          : 0,
        imageCount: extractedImages.length,
        answerKeyFound: foundAnswers.length > 0,
      },
    };
  };

  // ============================================================================
  // QUIZ GENERATION (Generate Mode)
  // ============================================================================

  const buildGenerationPrompt = (sourceText, config) => {
    const totalQuestions = Object.values(config.questionTypes).reduce((a, b) => a + b, 0);
    const typeBreakdown = Object.entries(config.questionTypes)
      .filter(([_, count]) => count > 0)
      .map(([type, count]) => `- ${type.replace(/_/g, ' ')}: ${count}`)
      .join('\n');

    const bloomsDescription = {
      remember: 'recall facts and basic concepts',
      understand: 'explain ideas or concepts',
      apply: 'use information in new situations',
      analyze: 'draw connections among ideas',
      evaluate: 'justify a decision or course of action',
      create: 'produce new or original work'
    };

    const targetedBlooms = config.bloomsLevels
      .map(level => `${level}: ${bloomsDescription[level]}`)
      .join(', ');

    return `You are an expert educator creating quiz questions from source material.

SOURCE MATERIAL:
${sourceText}

REQUIREMENTS:
Generate exactly ${totalQuestions} questions with this breakdown:
${typeBreakdown}

Difficulty level: ${config.difficulty}
Bloom's taxonomy levels to target: ${targetedBlooms}
${config.includeExplanations ? 'Include explanations for correct answers.' : 'Do not include explanations.'}

DISTRACTOR QUALITY: ${config.distractorQuality.replace(/_/g, ' ')}

CONSTRAINTS:
- All questions must be directly answerable from the source material
- Distractors must be plausible but clearly incorrect when compared to source
- Avoid trick questions, double negatives, and "all of the above" or "none of the above" options
- Each question should test a distinct concept from the material
- Match the requested difficulty and cognitive levels
- For true/false questions, ensure approximately half are true and half are false
- For matching questions, provide 4-6 pairs with clear, distinct matches
- For short answer and essay questions, provide a model answer

OUTPUT FORMAT - Return ONLY valid JSON matching this exact structure:
{
  "title": "Generated Quiz",
  "description": "Quiz generated from source material",
  "questions": [
    {
      "type": "multiple_choice",
      "text": "Question text here?",
      "points": 2,
      "options": [
        {"id": "a", "text": "Option A", "isCorrect": true},
        {"id": "b", "text": "Option B", "isCorrect": false},
        {"id": "c", "text": "Option C", "isCorrect": false},
        {"id": "d", "text": "Option D", "isCorrect": false}
      ],
      "explanation": "Explanation of why A is correct (if explanations enabled)",
      "confidence": 90
    },
    {
      "type": "true_false",
      "text": "Statement to evaluate as true or false.",
      "points": 1,
      "options": [
        {"id": "true", "text": "True", "isCorrect": true},
        {"id": "false", "text": "False", "isCorrect": false}
      ],
      "explanation": "Explanation",
      "confidence": 95
    },
    {
      "type": "short_answer",
      "text": "Short answer question?",
      "points": 3,
      "correctAnswer": "Expected answer or key points",
      "explanation": "Model answer or grading rubric",
      "confidence": 85
    },
    {
      "type": "essay",
      "text": "Essay question requiring detailed response?",
      "points": 10,
      "correctAnswer": "Key points that should be covered",
      "explanation": "Grading rubric or model answer outline",
      "confidence": 80
    },
    {
      "type": "matching",
      "text": "Match the items in Column A with Column B",
      "points": 4,
      "matchingPairs": [
        {"left": "Term 1", "right": "Definition 1"},
        {"left": "Term 2", "right": "Definition 2"},
        {"left": "Term 3", "right": "Definition 3"},
        {"left": "Term 4", "right": "Definition 4"}
      ],
      "confidence": 88
    },
    {
      "type": "fill_blank",
      "text": "Complete the sentence: The ____ is important because ____.",
      "points": 2,
      "correctAnswer": "First blank answer; Second blank answer",
      "confidence": 82
    },
    {
      "type": "ordering",
      "text": "Arrange the following in correct order:",
      "points": 3,
      "orderItems": ["First item", "Second item", "Third item", "Fourth item"],
      "confidence": 85
    },
    {
      "type": "numerical",
      "text": "Calculate the value of X.",
      "points": 2,
      "correctAnswer": "42",
      "tolerance": 0.5,
      "explanation": "Calculation steps",
      "confidence": 90
    }
  ]
}

IMPORTANT: Return ONLY the JSON object, no additional text before or after.`;
  };

  const parseGeneratedQuiz = (responseText) => {
    try {
      // Try to extract JSON from the response
      let jsonStr = responseText.trim();

      // If response has markdown code blocks, extract the JSON
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      const parsed = JSON.parse(jsonStr);

      // Validate and normalize the structure
      const questions = (parsed.questions || []).map((q, index) => ({
        id: `q${Date.now()}_${index}`,
        type: q.type || 'multiple_choice',
        text: q.text || 'Question text missing',
        points: q.points || 2,
        options: q.options || [],
        correctAnswer: q.correctAnswer || '',
        matchingPairs: q.matchingPairs || [],
        orderItems: q.orderItems || [],
        tolerance: q.tolerance,
        explanation: q.explanation || '',
        confidence: q.confidence || 80,
        warnings: [],
        images: [],
      }));

      // Add warnings for questions without correct answers
      questions.forEach(q => {
        if (['multiple_choice', 'multiple_select', 'true_false'].includes(q.type)) {
          if (!q.options || !q.options.some(o => o.isCorrect)) {
            q.warnings.push('No correct answer specified');
          }
        }
      });

      return {
        id: generateId(),
        title: parsed.title || 'Generated Quiz',
        description: parsed.description || 'Quiz generated from source material',
        questions,
        warnings: questions.length === 0 ? ['No questions generated'] : [],
        metadata: {
          sourceType: fileType || 'text',
          sourceFile: uploadedFile?.name || 'Source Material',
          createdAt: new Date().toISOString(),
          parseConfidence: questions.length > 0
            ? Math.round(questions.reduce((acc, q) => acc + q.confidence, 0) / questions.length)
            : 0,
          imageCount: 0,
          generatedQuiz: true,
        },
      };
    } catch (err) {
      console.error('Error parsing generated quiz:', err);
      throw new Error('Failed to parse generated quiz response. Please try again.');
    }
  };

  const handleGenerateQuiz = async () => {
    if (rateLimitInfo.remaining <= 0) {
      setError('Daily limit reached. Please try again tomorrow.');
      return;
    }

    if (!extractedText) {
      setError('Please upload a source document first.');
      return;
    }

    const totalQuestions = Object.values(generationConfig.questionTypes).reduce((a, b) => a + b, 0);
    if (totalQuestions === 0) {
      setError('Please select at least one question type with a count greater than 0.');
      return;
    }

    setIsProcessing(true);
    setCurrentStep(1);
    setProcessingProgress(0);
    setProcessingStatus('Preparing source material...');
    setError(null);

    try {
      setProcessingProgress(10);

      // Use page range if specified for PDFs
      let sourceText = extractedText;
      const startPage = pageRange.start ? parseInt(pageRange.start) : null;
      const endPage = pageRange.end ? parseInt(pageRange.end) : null;

      if ((startPage || endPage) && fileType === 'pdf' && uploadedFile) {
        setProcessingStatus('Extracting text from specified page range...');
        sourceText = await extractTextFromPdf(uploadedFile, startPage, endPage);
        setProcessingProgress(15);
      }

      setProcessingStatus('Building generation prompt...');

      // Check source material length
      const estimatedTokens = sourceText.length / 4;
      if (estimatedTokens > 100000) {
        setError('Warning: Source material is very long. Consider using page targeting to reduce length.');
      }

      setProcessingProgress(20);
      setProcessingStatus(`Generating ${totalQuestions} questions with AI...`);
      setRateLimitError(null);

      const prompt = buildGenerationPrompt(sourceText, generationConfig);

      const result = await callAnthropicProxy({
        model: MODEL_SONNET,
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      });

      setProcessingProgress(70);
      setProcessingStatus('Processing AI response...');

      const generatedContent = result.content?.[0]?.text;

      if (!generatedContent) {
        throw new Error('No content received from AI');
      }

      setProcessingProgress(90);
      setProcessingStatus('Building quiz structure...');

      const generatedQuiz = parseGeneratedQuiz(generatedContent);

      setProcessingProgress(100);
      setProcessingStatus('Complete!');

      setQuiz(generatedQuiz);
      setQuizSettings(prev => ({
        ...prev,
        title: generatedQuiz.title || 'Generated Quiz',
        description: generatedQuiz.description || '',
      }));

      setTimeout(() => {
        setIsProcessing(false);
        setCurrentStep(2);
      }, 500);

    } catch (err) {
      console.error('Generation error:', err);
      setError(err.message || 'Failed to generate quiz. Please try again.');
      setIsProcessing(false);
      setCurrentStep(0);
    }
  };

  const updateQuestion = (questionId, updates) => {
    setQuiz(prev => ({
      ...prev,
      questions: prev.questions.map(q => 
        q.id === questionId ? { ...q, ...updates } : q
      ),
    }));
  };

  const addImageToQuestion = async (questionId, file) => {
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const dimensions = await getImageDimensions(dataUrl);
      const newImage = {
        id: generateId(),
        filename: file.name,
        dataUrl,
        mimeType: file.type,
        size: file.size,
        width: dimensions.width,
        height: dimensions.height,
        source: 'upload',
      };
      setQuiz(prev => ({
        ...prev,
        questions: prev.questions.map(q => 
          q.id === questionId ? { ...q, images: [...(q.images || []), newImage] } : q
        ),
      }));
    } catch (error) {
      console.error('Error adding image:', error);
    }
  };

  const removeImageFromQuestion = (questionId, imageId) => {
    setQuiz(prev => ({
      ...prev,
      questions: prev.questions.map(q => 
        q.id === questionId ? { ...q, images: (q.images || []).filter(img => img.id !== imageId) } : q
      ),
    }));
  };

  const addQuestion = () => {
    const newQuestion = {
      id: `q${Date.now()}`,
      type: 'multiple_choice',
      text: 'New Question',
      points: 2,
      options: [
        { id: 'a', text: 'Option A', isCorrect: true },
        { id: 'b', text: 'Option B', isCorrect: false },
        { id: 'c', text: 'Option C', isCorrect: false },
        { id: 'd', text: 'Option D', isCorrect: false },
      ],
      correctAnswer: 'a',
      confidence: 100,
      warnings: [],
      images: [],
    };
    setQuiz(prev => ({ ...prev, questions: [...prev.questions, newQuestion] }));
    setSelectedQuestionIndex(quiz.questions.length);
  };

  const deleteQuestion = (questionId) => {
    setQuiz(prev => ({ ...prev, questions: prev.questions.filter(q => q.id !== questionId) }));
    setSelectedQuestionIndex(Math.max(0, selectedQuestionIndex - 1));
  };

  const handleApplyAnswerKey = (answers) => {
    setQuiz(prev => applyAnswerKey(prev, answers));
    setShowAnswerKeyModal(false);
  };

  const generateQTIExport = () => {
    const escapeXml = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    const generateImageHtml = (images) => {
      if (!images || images.length === 0) return '';
      return images.map(img => `<p><img src="${img.dataUrl}" alt="${escapeXml(img.filename || 'Question image')}" style="max-width: 100%; height: auto;" /></p>`).join('');
    };

    let qti = `<?xml version="1.0" encoding="UTF-8"?>
<questestinterop xmlns="http://www.imsglobal.org/xsd/ims_qtiasiv1p2">
  <assessment ident="${quiz.id}" title="${escapeXml(quizSettings.title)}">
    <qtimetadata>
      <qtimetadatafield>
        <fieldlabel>qmd_timelimit</fieldlabel>
        <fieldentry>${quizSettings.timeLimit * 60}</fieldentry>
      </qtimetadatafield>
      <qtimetadatafield>
        <fieldlabel>cc_maxattempts</fieldlabel>
        <fieldentry>${quizSettings.attemptsAllowed}</fieldentry>
      </qtimetadatafield>
    </qtimetadata>
    <section ident="root_section">
`;

    quiz.questions.forEach((q, index) => {
      const itemIdent = `item_${q.id}`;
      const imageHtml = generateImageHtml(q.images);
      const questionHtml = `<p>${escapeXml(q.text)}</p>${imageHtml}`;
      
      if (q.type === 'multiple_choice' || q.type === 'true_false') {
        qti += `      <item ident="${itemIdent}" title="Question ${index + 1}">
        <itemmetadata>
          <qtimetadata>
            <qtimetadatafield>
              <fieldlabel>question_type</fieldlabel>
              <fieldentry>${q.type === 'true_false' ? 'true_false_question' : 'multiple_choice_question'}</fieldentry>
            </qtimetadatafield>
            <qtimetadatafield>
              <fieldlabel>points_possible</fieldlabel>
              <fieldentry>${q.points}</fieldentry>
            </qtimetadatafield>
          </qtimetadata>
        </itemmetadata>
        <presentation>
          <material>
            <mattext texttype="text/html"><![CDATA[${questionHtml}]]></mattext>
          </material>
          <response_lid ident="response1" rcardinality="Single">
            <render_choice>
${q.options.map(opt => `              <response_label ident="${opt.id}">
                <material>
                  <mattext texttype="text/html"><![CDATA[<p>${escapeXml(opt.text)}</p>]]></mattext>
                </material>
              </response_label>`).join('\n')}
            </render_choice>
          </response_lid>
        </presentation>
        <resprocessing>
          <outcomes>
            <decvar maxvalue="100" minvalue="0" varname="SCORE" vartype="Decimal"/>
          </outcomes>
${q.options.find(o => o.isCorrect) ? `          <respcondition continue="No">
            <conditionvar>
              <varequal respident="response1">${q.options.find(o => o.isCorrect).id}</varequal>
            </conditionvar>
            <setvar action="Set" varname="SCORE">100</setvar>
          </respcondition>` : ''}
        </resprocessing>
      </item>
`;
      } else if (q.type === 'short_answer' || q.type === 'fill_blank' || q.type === 'essay') {
        qti += `      <item ident="${itemIdent}" title="Question ${index + 1}">
        <itemmetadata>
          <qtimetadata>
            <qtimetadatafield>
              <fieldlabel>question_type</fieldlabel>
              <fieldentry>${q.type === 'essay' ? 'essay_question' : 'short_answer_question'}</fieldentry>
            </qtimetadatafield>
            <qtimetadatafield>
              <fieldlabel>points_possible</fieldlabel>
              <fieldentry>${q.points}</fieldentry>
            </qtimetadatafield>
          </qtimetadata>
        </itemmetadata>
        <presentation>
          <material>
            <mattext texttype="text/html"><![CDATA[${questionHtml}]]></mattext>
          </material>
          <response_str ident="response1" rcardinality="Single">
            <render_fib>
              <response_label ident="answer1" rshuffle="No"/>
            </render_fib>
          </response_str>
        </presentation>
      </item>
`;
      }
    });

    qti += `    </section>
  </assessment>
</questestinterop>`;
    return qti;
  };

  const downloadExport = async () => {
    // Load JSZip if not already loaded
    if (!window.JSZip) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    }

    const zip = new window.JSZip();
    const quizId = quiz.id || generateId();
    const assessmentId = `assessment_${quizId}`;
    const safeTitle = quizSettings.title.replace(/[^a-z0-9]/gi, '_');

    // Collect all images and create file references
    const imageFiles = [];
    let imageCounter = 0;

    // Generate QTI with proper image references
    const escapeXml = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    const processImages = (images) => {
      if (!images || images.length === 0) return '';
      return images.map(img => {
        imageCounter++;
        const ext = img.mimeType?.split('/')[1] || 'png';
        const filename = `image_${imageCounter}.${ext}`;
        imageFiles.push({ filename, dataUrl: img.dataUrl, mimeType: img.mimeType || 'image/png' });
        return `<p><img src="%24IMS-CC-FILEBASE%24/${filename}" alt="${escapeXml(img.filename || 'Question image')}" style="max-width: 100%; height: auto;" /></p>`;
      }).join('');
    };

    // Check if any question has math content
    const hasMathContent = quiz.questions.some(q =>
      containsMath(q.text) || (q.options && q.options.some(opt => containsMath(opt.text)))
    );

    // Load rich text libraries if needed for math conversion
    if (hasMathContent) {
      await loadRichTextLibraries();
    }

    let qtiXml = `<?xml version="1.0" encoding="UTF-8"?>
<questestinterop xmlns="http://www.imsglobal.org/xsd/ims_qtiasiv1p2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/ims_qtiasiv1p2 http://www.imsglobal.org/xsd/ims_qtiasiv1p2p1.xsd">
  <assessment ident="${assessmentId}" title="${escapeXml(quizSettings.title)}">
    <qtimetadata>
      <qtimetadatafield>
        <fieldlabel>cc_maxattempts</fieldlabel>
        <fieldentry>${quizSettings.attemptsAllowed}</fieldentry>
      </qtimetadatafield>
    </qtimetadata>
    <section ident="root_section">
`;

    // Process questions sequentially to handle async math rendering
    for (let index = 0; index < quiz.questions.length; index++) {
      const q = quiz.questions[index];
      const itemIdent = `item_${q.id}`;
      const userImageHtml = processImages(q.images);

      // Process question text (convert math to images if present)
      let questionHtml;
      if (containsMath(q.text) || containsMarkdown(q.text)) {
        const result = await processTextForQTI(q.text, imageFiles, imageCounter);
        questionHtml = `<p>${result.html}</p>${userImageHtml}`;
        imageCounter = result.counter;
        result.images.forEach(img => imageFiles.push(img));
      } else {
        questionHtml = `<p>${escapeXml(q.text)}</p>${userImageHtml}`;
      }

      if (q.type === 'multiple_choice' || q.type === 'true_false') {
        // Process option texts
        const processedOptions = [];
        for (const opt of q.options) {
          if (containsMath(opt.text) || containsMarkdown(opt.text)) {
            const result = await processTextForQTI(opt.text, imageFiles, imageCounter);
            imageCounter = result.counter;
            result.images.forEach(img => imageFiles.push(img));
            processedOptions.push({ ...opt, processedHtml: `<p>${result.html}</p>` });
          } else {
            processedOptions.push({ ...opt, processedHtml: `<p>${escapeXml(opt.text)}</p>` });
          }
        }

        qtiXml += `      <item ident="${itemIdent}" title="Question ${index + 1}">
        <itemmetadata>
          <qtimetadata>
            <qtimetadatafield>
              <fieldlabel>question_type</fieldlabel>
              <fieldentry>${q.type === 'true_false' ? 'true_false_question' : 'multiple_choice_question'}</fieldentry>
            </qtimetadatafield>
            <qtimetadatafield>
              <fieldlabel>points_possible</fieldlabel>
              <fieldentry>${q.points}</fieldentry>
            </qtimetadatafield>
          </qtimetadata>
        </itemmetadata>
        <presentation>
          <material>
            <mattext texttype="text/html"><![CDATA[${questionHtml}]]></mattext>
          </material>
          <response_lid ident="response1" rcardinality="Single">
            <render_choice>
${processedOptions.map(opt => `              <response_label ident="${opt.id}">
                <material>
                  <mattext texttype="text/html"><![CDATA[${opt.processedHtml}]]></mattext>
                </material>
              </response_label>`).join('\n')}
            </render_choice>
          </response_lid>
        </presentation>
        <resprocessing>
          <outcomes>
            <decvar maxvalue="100" minvalue="0" varname="SCORE" vartype="Decimal"/>
          </outcomes>
${q.options.find(o => o.isCorrect) ? `          <respcondition continue="No">
            <conditionvar>
              <varequal respident="response1">${q.options.find(o => o.isCorrect).id}</varequal>
            </conditionvar>
            <setvar action="Set" varname="SCORE">100</setvar>
          </respcondition>` : ''}
        </resprocessing>
      </item>
`;
      } else if (q.type === 'short_answer' || q.type === 'fill_blank' || q.type === 'essay') {
        qtiXml += `      <item ident="${itemIdent}" title="Question ${index + 1}">
        <itemmetadata>
          <qtimetadata>
            <qtimetadatafield>
              <fieldlabel>question_type</fieldlabel>
              <fieldentry>${q.type === 'essay' ? 'essay_question' : 'short_answer_question'}</fieldentry>
            </qtimetadatafield>
            <qtimetadatafield>
              <fieldlabel>points_possible</fieldlabel>
              <fieldentry>${q.points}</fieldentry>
            </qtimetadatafield>
          </qtimetadata>
        </itemmetadata>
        <presentation>
          <material>
            <mattext texttype="text/html"><![CDATA[${questionHtml}]]></mattext>
          </material>
          <response_str ident="response1" rcardinality="Single">
            <render_fib>
              <response_label ident="answer1" rshuffle="No"/>
            </render_fib>
          </response_str>
        </presentation>
      </item>
`;
      }
    }

    qtiXml += `    </section>
  </assessment>
</questestinterop>`;

    // Create IMS manifest
    const resourceRefs = imageFiles.map(img =>
      `        <file href="${img.filename}"/>`
    ).join('\n');

    const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="manifest_${quizId}" xmlns="http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1" xmlns:lom="http://ltsc.ieee.org/xsd/imsccv1p1/LOM/resource" xmlns:imsmd="http://www.imsglobal.org/xsd/imsmd_v1p2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsglobal.org/xsd/imsccv1p1/imscp_v1p1 http://www.imsglobal.org/xsd/imscp_v1p1.xsd http://ltsc.ieee.org/xsd/imsccv1p1/LOM/resource http://www.imsglobal.org/profile/cc/ccv1p1/LOM/ccv1p1_lomresource_v1p0.xsd http://www.imsglobal.org/xsd/imsmd_v1p2 http://www.imsglobal.org/xsd/imsmd_v1p2p2.xsd">
  <metadata>
    <schema>IMS Content</schema>
    <schemaversion>1.1.3</schemaversion>
    <lom:lom>
      <lom:general>
        <lom:title>
          <lom:string>${escapeXml(quizSettings.title)}</lom:string>
        </lom:title>
      </lom:general>
    </lom:lom>
  </metadata>
  <organizations/>
  <resources>
    <resource identifier="${assessmentId}" type="imsqti_xmlv1p2">
      <file href="${assessmentId}.xml"/>
${resourceRefs}
    </resource>
  </resources>
</manifest>`;

    // Add files to ZIP
    zip.file('imsmanifest.xml', manifest);
    zip.file(`${assessmentId}.xml`, qtiXml);

    // Add images to ZIP
    for (const img of imageFiles) {
      // Convert data URL to binary
      const base64Data = img.dataUrl.split(',')[1];
      zip.file(img.filename, base64Data, { base64: true });
    }

    // Generate and download ZIP
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeTitle}_quiz.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleStartProcessing = () => {
    const content = textInput || extractedText;
    if (!content?.trim() && uploadedFiles.length === 0) {
      setError('Please enter quiz content or upload a file.');
      return;
    }
    processQuiz(content);
  };

  const handleReset = () => {
    setCurrentStep(0);
    setQuiz(null);
    setSelectedQuestionIndex(0);
    setUploadedFiles([]);
    setExtractedContents([]);
    setImportedQuizzes([]);
    setTextInput('');
    setExtractedText('');
    setError(null);
    setExtractedImages([]);
    setFileType(null);
    // Reset generate mode state
    setMode('parse');
    setPageRange({ start: '', end: '' });
    setGenerationConfig({
      questionTypes: {
        multiple_choice: 4,
        true_false: 3,
        short_answer: 2,
        essay: 1,
        matching: 0,
        ordering: 0,
        fill_blank: 0,
        numerical: 0
      },
      difficulty: 'medium',
      bloomsLevels: ['remember', 'understand'],
      includeExplanations: true,
      distractorQuality: 'plausible'
    });
  };

  return (
    <div style={styles.container}>
      <div style={styles.bgPattern} />
      
      <header style={styles.header}>
        <div style={styles.headerContent}>
          <div style={styles.logo}>
            <div style={styles.logoIcon}>
              <BookOpen size={24} color="#fff" />
            </div>
            <span style={styles.logoText}>Quick Quiz</span>
            <span style={styles.versionBadge}>v1</span>
          </div>
          
          {currentStep > 0 && (
            <div style={styles.progressSteps}>
              {steps.slice(0, -1).map((step, index) => {
                const Icon = step.icon;
                const isActive = currentStep === step.id;
                const isComplete = currentStep > step.id;
                const isClickable = isComplete || (step.id < currentStep);
                return (
                  <React.Fragment key={step.id}>
                    <button
                      style={{
                        ...styles.stepButton,
                        ...(isActive && styles.stepButtonActive),
                        ...(isComplete && styles.stepButtonComplete),
                        cursor: isClickable ? 'pointer' : 'default',
                        opacity: step.id > currentStep + 1 ? 0.4 : 1,
                      }}
                      onClick={() => isClickable && step.id !== 1 && setCurrentStep(step.id)}
                      disabled={!isClickable || step.id === 1}
                    >
                      {isComplete ? <Check size={16} /> : <Icon size={16} />}
                      <span style={styles.stepLabel}>{step.label}</span>
                    </button>
                    {index < steps.length - 2 && (
                      <div style={{ ...styles.stepConnector, backgroundColor: isComplete ? '#0b4901' : '#e5e7eb' }} />
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          )}
          
          <div style={styles.headerActions}>
            <div style={styles.usageIndicator}>
              <Sparkles size={16} />
              <span>{rateLimitInfo.remaining}/{rateLimitInfo.limit} uses today</span>
            </div>
            {currentStep > 0 && (
              <button style={styles.resetButton} onClick={handleReset}>
                <RotateCcw size={16} />
                Start Over
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Mode Selector - Only show on Step 0 */}
      {currentStep === 0 && (
        <div style={styles.modeSelector}>
          <div style={styles.modeSelectorContent}>
            <button
              style={{
                ...styles.modeTabMain,
                ...(mode === 'parse' && styles.modeTabMainActive)
              }}
              onClick={() => setMode('parse')}
            >
              <FileText size={18} />
              <span>Parse Existing Quiz</span>
            </button>
            <button
              style={{
                ...styles.modeTabMain,
                ...(mode === 'generate' && styles.modeTabMainActive)
              }}
              onClick={() => setMode('generate')}
            >
              <Sparkles size={18} />
              <span>Generate New Quiz</span>
            </button>
          </div>
        </div>
      )}

      <main style={styles.main}>
        {currentStep === 0 && mode === 'parse' && (
          <UploadStep
            uploadedFiles={uploadedFiles}
            textInput={textInput}
            showTextInput={showTextInput}
            fileInputRef={fileInputRef}
            error={error}
            apiKey={apiKey}
            extractedImages={extractedImages}
            extractedText={extractedText}
            fileType={fileType}
            processingStatus={processingStatus}
            importedQuizzes={importedQuizzes}
            rateLimitInfo={rateLimitInfo}
            rateLimitError={rateLimitError}
            onDrop={handleDrop}
            onFilesSelect={handleFilesSelect}
            onRemoveFile={removeFile}
            onClearAllFiles={clearAllFiles}
            onTextChange={setTextInput}
            onToggleTextInput={() => setShowTextInput(!showTextInput)}
            onStartProcessing={handleStartProcessing}
          />
        )}

        {currentStep === 0 && mode === 'generate' && (
          <GenerateUploadStep
            uploadedFiles={uploadedFiles}
            fileInputRef={fileInputRef}
            error={error}
            apiKey={apiKey}
            extractedText={extractedText}
            fileType={fileType}
            processingStatus={processingStatus}
            importedQuizzes={importedQuizzes}
            generationConfig={generationConfig}
            pageRange={pageRange}
            rateLimitInfo={rateLimitInfo}
            rateLimitError={rateLimitError}
            onDrop={handleDrop}
            onFilesSelect={handleFilesSelect}
            onRemoveFile={removeFile}
            onClearAllFiles={clearAllFiles}
            onConfigChange={setGenerationConfig}
            onPageRangeChange={setPageRange}
            onGenerate={handleGenerateQuiz}
          />
        )}

        {currentStep === 1 && (
          <ProcessingStep
            progress={processingProgress}
            status={processingStatus}
            imageCount={extractedImages.length}
          />
        )}

        {currentStep === 2 && quiz && (
          <EditStep
            quiz={quiz}
            selectedQuestionIndex={selectedQuestionIndex}
            questionsNeedingAnswers={questionsNeedingAnswers}
            onSelectQuestion={setSelectedQuestionIndex}
            onUpdateQuestion={updateQuestion}
            onAddQuestion={addQuestion}
            onDeleteQuestion={deleteQuestion}
            onAddImage={addImageToQuestion}
            onRemoveImage={removeImageFromQuestion}
            onNext={() => setCurrentStep(3)}
            onPreviewImage={setImagePreview}
            onOpenAnswerKey={() => setShowAnswerKeyModal(true)}
          />
        )}

        {currentStep === 3 && (
          <SettingsStep
            settings={quizSettings}
            onChange={setQuizSettings}
            onBack={() => setCurrentStep(2)}
            onNext={() => setCurrentStep(4)}
          />
        )}

        {currentStep === 4 && quiz && (
          <PreviewStep
            quiz={quiz}
            settings={quizSettings}
            onBack={() => setCurrentStep(3)}
            onNext={() => setCurrentStep(5)}
          />
        )}

        {currentStep === 5 && quiz && (
          <ExportStep
            quiz={quiz}
            settings={quizSettings}
            exportFormat={exportFormat}
            onFormatChange={setExportFormat}
            onDownload={downloadExport}
            onBack={() => setCurrentStep(4)}
          />
        )}
      </main>

      {showAnswerKeyModal && quiz && (
        <AnswerKeyModal
          quiz={quiz}
          onApply={handleApplyAnswerKey}
          onClose={() => setShowAnswerKeyModal(false)}
          apiKey={apiKey}
          callAnthropicProxy={callAnthropicProxy}
        />
      )}
      
      {imagePreview && (
        <ImagePreviewModal image={imagePreview} onClose={() => setImagePreview(null)} />
      )}
    </div>
  );
}

// ============================================================================
// UPLOAD STEP
// ============================================================================

function UploadStep({
  uploadedFiles, textInput, showTextInput, fileInputRef, error, apiKey,
  extractedImages, extractedText, fileType, processingStatus, importedQuizzes,
  rateLimitInfo, rateLimitError,
  onDrop, onFilesSelect, onRemoveFile, onClearAllFiles, onTextChange, onToggleTextInput, onStartProcessing,
}) {
  const [isDragging, setIsDragging] = useState(false);

  const getFileTypeIconForFile = (file) => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) return <FileType size={20} color="#ef4444" />;
    if (name.endsWith('.docx')) return <FileText size={20} color="#0b4901" />;
    if (name.endsWith('.xml')) return <BookOpen size={20} color="#10b981" />;
    if (name.endsWith('.zip')) return <Download size={20} color="#8b5cf6" />;
    return <FileText size={20} color="#64748b" />;
  };

  return (
    <div style={styles.uploadStep}>
      <div style={styles.uploadHero}>
        <h1 style={styles.heroTitle}>Transform Any Quiz into Canvas-Ready Format</h1>
        <p style={styles.heroSubtitle}>
          Upload PDFs, Word documents, or paste text. Quick Quiz extracts questions, detects answer keys, and handles messy formatting.
        </p>
      </div>

      {error && (
        <div style={error.startsWith('Warning') ? styles.warningBanner : styles.errorBanner}>
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      )}

      {rateLimitError && (
        <div style={styles.rateLimitBanner}>
          <AlertTriangle size={18} />
          <span>{rateLimitError}</span>
        </div>
      )}

      {rateLimitInfo && rateLimitInfo.remaining <= 3 && !rateLimitError && (
        <div style={styles.rateLimitWarning}>
          <span>{rateLimitInfo.remaining} of {rateLimitInfo.limit} daily uses remaining</span>
        </div>
      )}

      <div style={styles.uploadContainer}>
        <div
          style={{ ...styles.dropZone, ...(isDragging && styles.dropZoneDragging), ...(uploadedFiles.length > 0 && styles.dropZoneWithFile) }}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => { setIsDragging(false); onDrop(e); }}
          onClick={() => uploadedFiles.length === 0 && fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt,.xml,.zip"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              if (files.length > 0) onFilesSelect(files);
              e.target.value = '';
            }}
          />

          {uploadedFiles.length > 0 ? (
            <div style={styles.filePreviewContainer}>
              <div style={styles.fileListHeader}>
                <span style={styles.fileListTitle}>{uploadedFiles.length} file(s) selected</span>
                <div style={styles.fileListActions}>
                  <button
                    style={styles.addMoreButton}
                    onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                  >
                    <Plus size={16} /> Add more
                  </button>
                  <button
                    style={styles.clearAllButton}
                    onClick={(e) => { e.stopPropagation(); onClearAllFiles(); }}
                  >
                    <X size={16} /> Clear all
                  </button>
                </div>
              </div>

              <div style={styles.fileList}>
                {uploadedFiles.map((file) => (
                  <div key={file.name} style={styles.fileListItem}>
                    <div style={styles.fileListItemIcon}>{getFileTypeIconForFile(file)}</div>
                    <div style={styles.fileListItemInfo}>
                      <span style={styles.fileListItemName}>{file.name}</span>
                      <span style={styles.fileListItemSize}>{(file.size / 1024).toFixed(1)} KB</span>
                    </div>
                    <button
                      style={styles.fileListItemRemove}
                      onClick={(e) => { e.stopPropagation(); onRemoveFile(file.name); }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>

              {processingStatus && (
                <div style={styles.processingIndicator}>
                  <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                  <span>{processingStatus}</span>
                </div>
              )}

              {extractedText && !processingStatus && (
                <div style={styles.extractedTextPreview}>
                  <CheckCircle2 size={16} color="#10b981" />
                  <span>{extractedText.length.toLocaleString()} total characters extracted</span>
                </div>
              )}

              {extractedImages.length > 0 && (
                <div style={styles.extractedImagesPreview}>
                  <div style={styles.extractedImagesHeader}>
                    <ImageIcon size={16} color="#10b981" />
                    <span>{extractedImages.length} images detected</span>
                  </div>
                  <div style={styles.extractedImagesThumbs}>
                    {extractedImages.slice(0, 5).map((img, index) => (
                      <div key={img.id} style={styles.extractedThumb}>
                        <img src={img.dataUrl} alt={`Extracted ${index + 1}`} style={styles.extractedThumbImg} />
                      </div>
                    ))}
                    {extractedImages.length > 5 && (
                      <div style={styles.extractedThumbMore}>+{extractedImages.length - 5}</div>
                    )}
                  </div>
                </div>
              )}

              {importedQuizzes.length > 0 && (
                <div style={styles.importedQuizSummary}>
                  <div style={styles.importedQuizHeader}>
                    <CheckCircle2 size={16} color="#8b5cf6" />
                    <span>{importedQuizzes.length} LMS quiz(es) detected</span>
                  </div>
                  {importedQuizzes.map((quiz, i) => (
                    <div key={quiz.id || i} style={styles.importedQuizItem}>
                      <span style={styles.importedQuizTitle}>{quiz.title}</span>
                      <span style={styles.importedQuizCount}>{quiz.questions.length} questions</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <div style={styles.uploadIcon}><Upload size={40} strokeWidth={1.5} /></div>
              <p style={styles.dropText}>
                <span style={styles.dropTextBold}>Drop your quiz files here</span><br />or click to browse (multiple files supported)
              </p>
              <div style={styles.supportedFormatsRow}>
                <span style={styles.formatBadge}><FileType size={14} /> PDF</span>
                <span style={styles.formatBadge}><FileText size={14} /> DOCX</span>
                <span style={styles.formatBadge}><AlignLeft size={14} /> TXT</span>
                <span style={styles.formatBadge}><Download size={14} /> QTI</span>
                <span style={styles.formatBadge}><BookOpen size={14} /> Moodle</span>
              </div>
            </>
          )}
        </div>

        <div style={styles.divider}><span style={styles.dividerText}>or</span></div>

        <button style={{ ...styles.textInputToggle, ...(showTextInput && styles.textInputToggleActive) }} onClick={onToggleTextInput}>
          <Copy size={20} />
          <span>Paste quiz text directly</span>
          <ChevronRight size={18} style={{ transform: showTextInput ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }} />
        </button>

        {showTextInput && (
          <div style={styles.textInputContainer}>
            <textarea
              style={styles.textArea}
              value={textInput}
              onChange={(e) => onTextChange(e.target.value)}
              placeholder={`Paste your quiz content here...

Tip: Include your answer key at the end!
Example: "Answer Key: 1-B, 2-A, 3-C" or just "B, A, C, D, A"`}
              rows={12}
            />
          </div>
        )}
      </div>

      <div style={styles.processButtonContainer}>
        <button
          style={{ ...styles.processButton, opacity: (uploadedFiles.length === 0 && !textInput.trim()) ? 0.6 : 1 }}
          onClick={onStartProcessing}
          disabled={(uploadedFiles.length === 0 && !textInput.trim()) || !!processingStatus}
        >
          <Wand2 size={20} />
          <span>Process Quiz</span>
          <ChevronRight size={20} />
        </button>
        {!apiKey && (
          <p style={styles.demoNote}>
            <Sparkles size={14} />
            Running in demo mode. Connect your Anthropic API key for full AI parsing.
          </p>
        )}
      </div>

      <div style={styles.features}>
        <div style={styles.feature}>
          <div style={styles.featureIcon}><FileType size={24} /></div>
          <h3 style={styles.featureTitle}>PDF & Word Support</h3>
          <p style={styles.featureDesc}>Upload PDFs or Word docs — we extract text and images automatically</p>
        </div>
        <div style={styles.feature}>
          <div style={{ ...styles.featureIcon, backgroundColor: '#fef3c7' }}><Key size={24} color="#f59e0b" /></div>
          <h3 style={styles.featureTitle}>Answer Key Detection</h3>
          <p style={styles.featureDesc}>Automatically finds and applies answer keys from your document</p>
        </div>
        <div style={styles.feature}>
          <div style={{ ...styles.featureIcon, backgroundColor: '#ecfdf5' }}><ImageIcon size={24} color="#10b981" /></div>
          <h3 style={styles.featureTitle}>Image Extraction</h3>
          <p style={styles.featureDesc}>Charts and diagrams are preserved at original quality</p>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// GENERATE UPLOAD STEP (Quiz Generator Mode)
// ============================================================================

function GenerateUploadStep({
  uploadedFiles, fileInputRef, error, apiKey, extractedText, fileType, processingStatus, importedQuizzes,
  generationConfig, pageRange, rateLimitInfo, rateLimitError,
  onDrop, onFilesSelect, onRemoveFile, onClearAllFiles, onConfigChange, onPageRangeChange, onGenerate
}) {
  const [isDragging, setIsDragging] = useState(false);

  const BLOOMS_LEVELS = [
    { id: 'remember', label: 'Remember', desc: 'Recall facts and basic concepts' },
    { id: 'understand', label: 'Understand', desc: 'Explain ideas or concepts' },
    { id: 'apply', label: 'Apply', desc: 'Use information in new situations' },
    { id: 'analyze', label: 'Analyze', desc: 'Draw connections among ideas' },
    { id: 'evaluate', label: 'Evaluate', desc: 'Justify a decision or course of action' },
    { id: 'create', label: 'Create', desc: 'Produce new or original work' },
  ];

  const totalQuestions = Object.values(generationConfig.questionTypes).reduce((a, b) => a + b, 0);

  const updateQuestionTypeCount = (type, count) => {
    onConfigChange({
      ...generationConfig,
      questionTypes: {
        ...generationConfig.questionTypes,
        [type]: Math.max(0, parseInt(count) || 0)
      }
    });
  };

  const toggleBloomsLevel = (level) => {
    const current = generationConfig.bloomsLevels;
    const updated = current.includes(level)
      ? current.filter(l => l !== level)
      : [...current, level];
    onConfigChange({ ...generationConfig, bloomsLevels: updated });
  };

  const getFileTypeIconForFile = (file) => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) return <FileType size={20} color="#ef4444" />;
    if (name.endsWith('.docx')) return <FileText size={20} color="#0b4901" />;
    if (name.endsWith('.xml')) return <BookOpen size={20} color="#10b981" />;
    if (name.endsWith('.zip')) return <Download size={20} color="#8b5cf6" />;
    return <FileText size={20} color="#64748b" />;
  };

  return (
    <div style={styles.generateStep}>
      <div style={styles.uploadHero}>
        <h1 style={styles.heroTitle}>Generate Quiz from Source Material</h1>
        <p style={styles.heroSubtitle}>
          Upload textbook chapters, lecture notes, or articles. Our AI will create original quiz questions based on your content.
        </p>
      </div>

      {error && (
        <div style={error.startsWith('Warning') ? styles.warningBanner : styles.errorBanner}>
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      )}

      {rateLimitError && (
        <div style={styles.rateLimitBanner}>
          <AlertTriangle size={18} />
          <span>{rateLimitError}</span>
        </div>
      )}

      {rateLimitInfo && rateLimitInfo.remaining <= 3 && !rateLimitError && (
        <div style={styles.rateLimitWarning}>
          <span>{rateLimitInfo.remaining} of {rateLimitInfo.limit} daily uses remaining</span>
        </div>
      )}

      <div style={styles.generateLayout}>
        {/* Left Column: Source Material */}
        <div style={styles.generateSourceSection}>
          <h2 style={styles.generateSectionTitle}>
            <FileText size={20} />
            Source Material
          </h2>

          <div
            style={{ ...styles.dropZone, ...(isDragging && styles.dropZoneDragging), ...(uploadedFiles.length > 0 && styles.dropZoneWithFile) }}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => { setIsDragging(false); onDrop(e); }}
            onClick={() => uploadedFiles.length === 0 && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.txt,.xml,.zip"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length > 0) onFilesSelect(files);
                e.target.value = '';
              }}
            />

            {uploadedFiles.length > 0 ? (
              <div style={styles.filePreviewContainer}>
                <div style={styles.fileListHeader}>
                  <span style={styles.fileListTitle}>{uploadedFiles.length} file(s) selected</span>
                  <div style={styles.fileListActions}>
                    <button
                      style={styles.addMoreButton}
                      onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                    >
                      <Plus size={16} /> Add more
                    </button>
                    <button
                      style={styles.clearAllButton}
                      onClick={(e) => { e.stopPropagation(); onClearAllFiles(); }}
                    >
                      <X size={16} /> Clear all
                    </button>
                  </div>
                </div>

                <div style={styles.fileList}>
                  {uploadedFiles.map((file) => (
                    <div key={file.name} style={styles.fileListItem}>
                      <div style={styles.fileListItemIcon}>{getFileTypeIconForFile(file)}</div>
                      <div style={styles.fileListItemInfo}>
                        <span style={styles.fileListItemName}>{file.name}</span>
                        <span style={styles.fileListItemSize}>{(file.size / 1024).toFixed(1)} KB</span>
                      </div>
                      <button
                        style={styles.fileListItemRemove}
                        onClick={(e) => { e.stopPropagation(); onRemoveFile(file.name); }}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                </div>

                {processingStatus && (
                  <div style={styles.processingIndicator}>
                    <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                    <span>{processingStatus}</span>
                  </div>
                )}

                {extractedText && !processingStatus && (
                  <div style={styles.extractedTextPreview}>
                    <CheckCircle2 size={16} color="#10b981" />
                    <span>{extractedText.length.toLocaleString()} total characters extracted</span>
                  </div>
                )}

                {importedQuizzes && importedQuizzes.length > 0 && (
                  <div style={styles.importedQuizSummary}>
                    <div style={styles.importedQuizHeader}>
                      <CheckCircle2 size={16} color="#8b5cf6" />
                      <span>{importedQuizzes.length} LMS quiz(es) detected</span>
                    </div>
                    {importedQuizzes.map((quiz, i) => (
                      <div key={quiz.id || i} style={styles.importedQuizItem}>
                        <span style={styles.importedQuizTitle}>{quiz.title}</span>
                        <span style={styles.importedQuizCount}>{quiz.questions.length} questions</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div style={styles.uploadIcon}><Upload size={40} strokeWidth={1.5} /></div>
                <p style={styles.dropText}>
                  <span style={styles.dropTextBold}>Drop your source material here</span><br />or click to browse (multiple files supported)
                </p>
                <div style={styles.supportedFormatsRow}>
                  <span style={styles.formatBadge}><FileType size={14} /> PDF</span>
                  <span style={styles.formatBadge}><FileText size={14} /> DOCX</span>
                  <span style={styles.formatBadge}><AlignLeft size={14} /> TXT</span>
                  <span style={styles.formatBadge}><Download size={14} /> QTI</span>
                  <span style={styles.formatBadge}><BookOpen size={14} /> Moodle</span>
                </div>
              </>
            )}
          </div>

          {/* Page Range Targeting */}
          <div style={styles.pageRangeSection}>
            <label style={styles.pageRangeLabel}>
              <Target size={16} />
              Focus on pages (optional)
            </label>
            <div style={styles.pageRangeInputs}>
              <input
                type="number"
                placeholder="Start"
                value={pageRange.start}
                onChange={(e) => onPageRangeChange({ ...pageRange, start: e.target.value })}
                style={styles.pageRangeInput}
                min="1"
              />
              <span style={styles.pageRangeTo}>to</span>
              <input
                type="number"
                placeholder="End"
                value={pageRange.end}
                onChange={(e) => onPageRangeChange({ ...pageRange, end: e.target.value })}
                style={styles.pageRangeInput}
                min="1"
              />
            </div>
            <p style={styles.pageRangeHint}>Leave empty to use entire document</p>
          </div>
        </div>

        {/* Right Column: Configuration */}
        <div style={styles.generateConfigSection}>
          <h2 style={styles.generateSectionTitle}>
            <Settings size={20} />
            Question Configuration
          </h2>

          {/* Question Types Grid */}
          <div style={styles.configCard}>
            <div style={styles.configCardHeader}>
              <span style={styles.configCardTitle}>Question Types</span>
              <span style={styles.totalQuestionsLabel}>Total: {totalQuestions} questions</span>
            </div>
            <div style={styles.questionTypesGrid}>
              {Object.entries(QUESTION_TYPES).map(([type, config]) => {
                const Icon = config.icon;
                return (
                  <div key={type} style={styles.questionTypeRow}>
                    <div style={styles.questionTypeInfo}>
                      <Icon size={16} color={config.color} />
                      <span style={styles.genQuestionTypeLabel}>{config.label}</span>
                    </div>
                    <input
                      type="number"
                      min="0"
                      max="50"
                      value={generationConfig.questionTypes[type]}
                      onChange={(e) => updateQuestionTypeCount(type, e.target.value)}
                      style={styles.questionTypeInput}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Difficulty Selection */}
          <div style={styles.configCard}>
            <span style={styles.configCardTitle}>Difficulty</span>
            <div style={styles.difficultyOptions}>
              {['easy', 'medium', 'hard', 'mixed'].map((level) => (
                <button
                  key={level}
                  style={{
                    ...styles.difficultyButton,
                    ...(generationConfig.difficulty === level && styles.difficultyButtonActive)
                  }}
                  onClick={() => onConfigChange({ ...generationConfig, difficulty: level })}
                >
                  {level.charAt(0).toUpperCase() + level.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Bloom's Taxonomy */}
          <div style={styles.configCard}>
            <div style={styles.configCardHeader}>
              <span style={styles.configCardTitle}>Bloom's Taxonomy Levels</span>
              <span style={styles.bloomsSelectedCount}>{generationConfig.bloomsLevels.length} selected</span>
            </div>
            <div style={styles.bloomsGrid}>
              {BLOOMS_LEVELS.map((level) => (
                <button
                  key={level.id}
                  style={{
                    ...styles.bloomsButton,
                    ...(generationConfig.bloomsLevels.includes(level.id) && styles.bloomsButtonActive)
                  }}
                  onClick={() => toggleBloomsLevel(level.id)}
                  title={level.desc}
                >
                  {generationConfig.bloomsLevels.includes(level.id) && <Check size={14} />}
                  {level.label}
                </button>
              ))}
            </div>
          </div>

          {/* Additional Options */}
          <div style={styles.configCard}>
            <span style={styles.configCardTitle}>Output Options</span>
            <div style={styles.optionsColumn}>
              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={generationConfig.includeExplanations}
                  onChange={(e) => onConfigChange({ ...generationConfig, includeExplanations: e.target.checked })}
                  style={styles.checkbox}
                />
                <span>Include answer explanations</span>
              </label>

              <div style={styles.selectField}>
                <label style={styles.selectLabel}>Distractor quality:</label>
                <select
                  value={generationConfig.distractorQuality}
                  onChange={(e) => onConfigChange({ ...generationConfig, distractorQuality: e.target.value })}
                  style={styles.selectInput}
                >
                  <option value="plausible">Plausible</option>
                  <option value="very_plausible">Very plausible</option>
                  <option value="common_misconceptions">Based on common misconceptions</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Generate Button */}
      <div style={styles.processButtonContainer}>
        <button
          style={{
            ...styles.processButton,
            opacity: (uploadedFiles.length === 0 || totalQuestions === 0 || processingStatus) ? 0.6 : 1
          }}
          onClick={onGenerate}
          disabled={uploadedFiles.length === 0 || totalQuestions === 0 || !!processingStatus}
        >
          <Sparkles size={20} />
          <span>Generate {totalQuestions} Questions</span>
          <ChevronRight size={20} />
        </button>
        {totalQuestions === 0 && (
          <p style={styles.demoNote}>
            <AlertTriangle size={14} />
            Select at least one question type and set a count greater than 0.
          </p>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// PROCESSING STEP
// ============================================================================

function ProcessingStep({ progress, status, imageCount }) {
  return (
    <div style={styles.processingStep}>
      <div style={styles.processingCard}>
        <div style={styles.processingIcon}>
          <Wand2 size={48} style={{ animation: 'pulse 2s infinite' }} />
        </div>
        <h2 style={styles.processingTitle}>Processing Your Quiz</h2>
        <p style={styles.processingStatus}>{status}</p>
        
        {imageCount > 0 && (
          <div style={styles.imageCountBadge}>
            <ImageIcon size={16} />
            <span>{imageCount} images will be processed</span>
          </div>
        )}
        
        <div style={styles.progressBarContainer}>
          <div style={styles.progressBarBg}>
            <div style={{ ...styles.progressBarFill, width: `${progress}%` }} />
          </div>
          <span style={styles.progressPercent}>{progress}%</span>
        </div>
        
        <div style={styles.processingSteps}>
          <ProcessingStepItem label="Reading document" done={progress >= 20} active={progress >= 10 && progress < 20} />
          <ProcessingStepItem label="Analyzing structure" done={progress >= 50} active={progress >= 35 && progress < 50} />
          <ProcessingStepItem label="Extracting questions" done={progress >= 65} active={progress >= 50 && progress < 65} />
          <ProcessingStepItem label="Looking for answer key" done={progress >= 85} active={progress >= 75 && progress < 85} />
          <ProcessingStepItem label="Finalizing" done={progress >= 100} active={progress >= 95 && progress < 100} />
        </div>
      </div>
    </div>
  );
}

function ProcessingStepItem({ label, done, active }) {
  return (
    <div style={{ ...styles.processingStepItem, opacity: done || active ? 1 : 0.4 }}>
      {done ? <CheckCircle2 size={18} color="#10b981" /> : active ? <Loader2 size={18} color="#0b4901" style={{ animation: 'spin 1s linear infinite' }} /> : <Circle size={18} color="#9ca3af" />}
      <span style={{ color: done ? '#10b981' : active ? '#0b4901' : '#6b7280', fontWeight: active ? '600' : '400' }}>{label}</span>
    </div>
  );
}

// ============================================================================
// EDIT STEP
// ============================================================================

function EditStep({ 
  quiz, selectedQuestionIndex, questionsNeedingAnswers,
  onSelectQuestion, onUpdateQuestion, onAddQuestion, onDeleteQuestion,
  onAddImage, onRemoveImage, onNext, onPreviewImage, onOpenAnswerKey,
}) {
  const selectedQuestion = quiz.questions[selectedQuestionIndex];
  const warningCount = quiz.questions.filter(q => q.warnings?.length > 0).length;
  const totalImages = quiz.questions.reduce((acc, q) => acc + (q.images?.length || 0), 0);

  return (
    <div style={styles.editStep}>
      <div style={styles.summaryBar}>
        <div style={styles.summaryStats}>
          <div style={styles.statItem}>
            <span style={styles.statValue}>{quiz.questions.length}</span>
            <span style={styles.statLabel}>Questions</span>
          </div>
          <div style={styles.statDivider} />
          <div style={styles.statItem}>
            <span style={styles.statValue}>{quiz.questions.reduce((acc, q) => acc + (q.points || 0), 0)}</span>
            <span style={styles.statLabel}>Total Points</span>
          </div>
          {totalImages > 0 && (
            <>
              <div style={styles.statDivider} />
              <div style={styles.statItem}>
                <span style={{ ...styles.statValue, color: '#10b981' }}>{totalImages}</span>
                <span style={styles.statLabel}>Images</span>
              </div>
            </>
          )}
          <div style={styles.statDivider} />
          <div style={styles.statItem}>
            <span style={{
              ...styles.statValue,
              color: quiz.metadata.parseConfidence >= 90 ? '#10b981' : quiz.metadata.parseConfidence >= 70 ? '#f59e0b' : '#ef4444',
            }}>{quiz.metadata.parseConfidence}%</span>
            <span style={styles.statLabel}>Confidence</span>
          </div>
        </div>
        
        <div style={styles.summaryActions}>
          {questionsNeedingAnswers > 0 && (
            <button style={styles.answerKeyButton} onClick={onOpenAnswerKey}>
              <Key size={16} />
              <span>{questionsNeedingAnswers} need answers</span>
            </button>
          )}
          <button style={styles.continueButton} onClick={onNext}>
            Continue to Settings
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {/* Answer Key Found Banner */}
      {quiz.metadata.answerKeyFound && (
        <div style={styles.answerKeyFoundBanner}>
          <CheckCircle2 size={18} />
          <span>Answer key detected and applied automatically</span>
        </div>
      )}

      <div style={styles.editLayout}>
        <div style={styles.questionList}>
          <div style={styles.questionListHeader}>
            <h3 style={styles.questionListTitle}>Questions</h3>
            <button style={styles.addQuestionButton} onClick={onAddQuestion}><Plus size={18} /></button>
          </div>
          
          <div style={styles.questionListScroll}>
            {quiz.questions.map((question, index) => {
              const TypeIcon = QUESTION_TYPES[question.type]?.icon || FileText;
              const hasWarnings = question.warnings?.length > 0;
              const hasImages = question.images?.length > 0;
              const needsAnswer = ['multiple_choice', 'multiple_select', 'true_false'].includes(question.type) && !question.options?.some(opt => opt.isCorrect);
              
              return (
                <button
                  key={question.id}
                  style={{
                    ...styles.questionListItem,
                    ...(selectedQuestionIndex === index && styles.questionListItemSelected),
                    ...(hasWarnings && styles.questionListItemWarning),
                  }}
                  onClick={() => onSelectQuestion(index)}
                >
                  <div style={styles.questionListItemLeft}>
                    <span style={styles.questionNumber}>{index + 1}</span>
                    <TypeIcon size={16} color={QUESTION_TYPES[question.type]?.color || '#6b7280'} />
                  </div>
                  <div style={styles.questionListItemContent}>
                    <p style={styles.questionPreviewText}>
                      {question.text.length > 40 ? question.text.substring(0, 40) + '...' : question.text}
                    </p>
                    <div style={styles.questionMetaRow}>
                      <span style={styles.questionTypeLabel}>{QUESTION_TYPES[question.type]?.label || question.type}</span>
                      {hasImages && <span style={styles.imageIndicator}><ImageIcon size={12} />{question.images.length}</span>}
                      {needsAnswer && <span style={styles.needsAnswerIndicator}><Key size={12} /></span>}
                    </div>
                  </div>
                  {hasWarnings && <AlertTriangle size={16} color="#f59e0b" />}
                </button>
              );
            })}
          </div>
        </div>

        <div style={styles.questionEditor}>
          {selectedQuestion ? (
            <QuestionEditor
              question={selectedQuestion}
              questionNumber={selectedQuestionIndex + 1}
              totalQuestions={quiz.questions.length}
              onUpdate={(updates) => onUpdateQuestion(selectedQuestion.id, updates)}
              onDelete={() => onDeleteQuestion(selectedQuestion.id)}
              onPrev={() => onSelectQuestion(Math.max(0, selectedQuestionIndex - 1))}
              onNext={() => onSelectQuestion(Math.min(quiz.questions.length - 1, selectedQuestionIndex + 1))}
              onAddImage={(file) => onAddImage(selectedQuestion.id, file)}
              onRemoveImage={(imageId) => onRemoveImage(selectedQuestion.id, imageId)}
              onPreviewImage={onPreviewImage}
            />
          ) : (
            <div style={styles.noQuestionSelected}>
              <FileText size={48} color="#d1d5db" />
              <p>Select a question to edit</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// QUESTION EDITOR
// ============================================================================

function QuestionEditor({ question, questionNumber, totalQuestions, onUpdate, onDelete, onPrev, onNext, onAddImage, onRemoveImage, onPreviewImage }) {
  const imageInputRef = useRef(null);
  const textAreaRef = useRef(null);
  const [showPreview, setShowPreview] = useState(false);

  const handleOptionChange = (optionId, field, value) => {
    const newOptions = question.options.map(opt => opt.id === optionId ? { ...opt, [field]: value } : opt);
    onUpdate({ options: newOptions });
  };

  const handleCorrectAnswerChange = (optionId) => {
    if (question.type === 'multiple_select') {
      const newOptions = question.options.map(opt => ({ ...opt, isCorrect: opt.id === optionId ? !opt.isCorrect : opt.isCorrect }));
      onUpdate({ options: newOptions });
    } else {
      const newOptions = question.options.map(opt => ({ ...opt, isCorrect: opt.id === optionId }));
      onUpdate({ options: newOptions, correctAnswer: optionId, warnings: question.warnings.filter(w => w !== 'No correct answer detected') });
    }
  };

  const addOption = () => {
    const newId = String.fromCharCode(97 + question.options.length);
    onUpdate({ options: [...question.options, { id: newId, text: `Option ${newId.toUpperCase()}`, isCorrect: false }] });
  };

  const removeOption = (optionId) => {
    onUpdate({ options: question.options.filter(opt => opt.id !== optionId) });
  };

  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) onAddImage(file);
    e.target.value = '';
  };

  // Math toolbar insertion helpers
  const insertMath = (template, cursorOffset = 0) => {
    const textarea = textAreaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = question.text;
    const selectedText = text.substring(start, end);

    let insertion;
    if (selectedText && template.includes('{}')) {
      insertion = template.replace('{}', selectedText);
    } else {
      insertion = template;
    }

    const newText = text.substring(0, start) + insertion + text.substring(end);
    onUpdate({ text: newText });

    // Set cursor position after React updates
    setTimeout(() => {
      textarea.focus();
      const newPos = start + insertion.length + cursorOffset;
      textarea.setSelectionRange(newPos, newPos);
    }, 0);
  };

  const mathButtons = [
    { label: 'x²', template: '^{2}', title: 'Superscript' },
    { label: 'xₙ', template: '_{n}', title: 'Subscript' },
    { label: '√', template: '\\sqrt{}', title: 'Square root' },
    { label: 'a/b', template: '\\frac{a}{b}', title: 'Fraction' },
    { label: '$', template: '$$', title: 'Inline math' },
    { label: '$$', template: '\n$$\n\n$$\n', title: 'Display math block' },
  ];

  const hasMathOrMarkdown = containsMath(question.text) || containsMarkdown(question.text);

  return (
    <div style={styles.editorContainer}>
      <div style={styles.editorHeader}>
        <div style={styles.editorNav}>
          <button style={styles.navButton} onClick={onPrev} disabled={questionNumber === 1}><ChevronLeft size={20} /></button>
          <span style={styles.questionCounter}>Question {questionNumber} of {totalQuestions}</span>
          <button style={styles.navButton} onClick={onNext} disabled={questionNumber === totalQuestions}><ChevronRight size={20} /></button>
        </div>
        <button style={styles.deleteButton} onClick={onDelete}><Trash2 size={18} />Delete</button>
      </div>

      {question.warnings?.length > 0 && (
        <div style={styles.warningsContainer}>
          {question.warnings.map((warning, index) => (
            <div key={index} style={styles.warningItem}><AlertTriangle size={16} /><span>{warning}</span></div>
          ))}
        </div>
      )}

      <div style={styles.editorField}>
        <label style={styles.fieldLabel}>Question Type</label>
        <div style={styles.typeSelector}>
          {Object.entries(QUESTION_TYPES).slice(0, 6).map(([type, config]) => {
            const Icon = config.icon;
            return (
              <button key={type} style={{ ...styles.typeOption, ...(question.type === type && styles.typeOptionSelected), borderColor: question.type === type ? config.color : '#e5e7eb' }} onClick={() => onUpdate({ type })}>
                <Icon size={18} color={question.type === type ? config.color : '#6b7280'} />
                <span>{config.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={styles.editorField}>
        <div style={styles.fieldLabelRow}>
          <label style={styles.fieldLabel}>Question Text</label>
          <div style={styles.editPreviewToggle}>
            <button
              style={{...styles.toggleButton, ...(showPreview ? {} : styles.toggleButtonActive)}}
              onClick={() => setShowPreview(false)}
            >
              Edit
            </button>
            <button
              style={{...styles.toggleButton, ...(showPreview ? styles.toggleButtonActive : {})}}
              onClick={() => setShowPreview(true)}
            >
              Preview
            </button>
          </div>
        </div>

        {!showPreview && (
          <>
            <div style={styles.mathToolbar}>
              {mathButtons.map((btn, i) => (
                <button
                  key={i}
                  style={styles.mathToolbarButton}
                  onClick={() => insertMath(btn.template)}
                  title={btn.title}
                >
                  {btn.label}
                </button>
              ))}
              <span style={styles.mathToolbarHint}>Use $...$ for inline math, $$...$$ for display math</span>
            </div>
            <textarea
              ref={textAreaRef}
              style={styles.questionTextArea}
              value={question.text}
              onChange={(e) => onUpdate({ text: e.target.value })}
              rows={3}
              placeholder="Enter question text. Use $..$ for math like $x^2 + y^2 = z^2$"
            />
          </>
        )}

        {showPreview && (
          <div style={styles.questionPreviewBox}>
            {hasMathOrMarkdown ? (
              <RichTextRenderer text={question.text} />
            ) : (
              <p style={styles.questionPreviewText}>{question.text}</p>
            )}
          </div>
        )}
      </div>

      <div style={styles.editorField}>
        <label style={styles.fieldLabel}><ImageIcon size={14} style={{ marginRight: '6px', verticalAlign: 'middle' }} />Images</label>
        {question.images?.length > 0 ? (
          <div style={styles.imageGrid}>
            {question.images.map((img, index) => (
              <div key={img.id} style={styles.imageCard}>
                <div style={styles.imagePreviewWrapper} onClick={() => onPreviewImage(img)}>
                  <img src={img.dataUrl} alt={`Question image ${index + 1}`} style={styles.imagePreview} />
                </div>
                <button style={styles.removeImageButton} onClick={() => onRemoveImage(img.id)}><X size={14} /></button>
              </div>
            ))}
            <button style={styles.addImageCard} onClick={() => imageInputRef.current?.click()}>
              <ImagePlus size={24} color="#9ca3af" /><span>Add</span>
            </button>
          </div>
        ) : (
          <button style={styles.imageDropZone} onClick={() => imageInputRef.current?.click()}>
            <ImagePlus size={28} color="#9ca3af" />
            <span style={styles.imageDropText}>Click to add image</span>
          </button>
        )}
        <input ref={imageInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleImageUpload} />
      </div>

      <div style={styles.editorFieldRow}>
        <div style={styles.editorFieldSmall}>
          <label style={styles.fieldLabel}>Points</label>
          <input type="number" style={styles.pointsInput} value={question.points} onChange={(e) => onUpdate({ points: parseInt(e.target.value) || 0 })} min={0} />
        </div>
      </div>

      {['multiple_choice', 'multiple_select', 'true_false'].includes(question.type) && (
        <div style={styles.editorField}>
          <label style={styles.fieldLabel}>Answer Options {question.type === 'multiple_select' && <span style={styles.fieldHint}>(select all correct)</span>}</label>
          <div style={styles.optionsList}>
            {question.options.map((option) => (
              <div key={option.id} style={styles.optionItem}>
                <button style={{ ...styles.correctToggle, ...(option.isCorrect && styles.correctToggleActive) }} onClick={() => handleCorrectAnswerChange(option.id)}>
                  {option.isCorrect ? <CheckCircle2 size={20} color="#10b981" /> : <Circle size={20} color="#d1d5db" />}
                </button>
                <span style={styles.optionLetter}>{option.id.toUpperCase()})</span>
                <input type="text" style={styles.optionInput} value={option.text} onChange={(e) => handleOptionChange(option.id, 'text', e.target.value)} />
                {question.type !== 'true_false' && question.options.length > 2 && (
                  <button style={styles.removeOptionButton} onClick={() => removeOption(option.id)}><X size={16} /></button>
                )}
              </div>
            ))}
            {question.type !== 'true_false' && question.options.length < 6 && (
              <button style={styles.addOptionButton} onClick={addOption}><Plus size={16} />Add Option</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ANSWER KEY MODAL
// ============================================================================

function AnswerKeyModal({ quiz, onApply, onClose, apiKey, callAnthropicProxy }) {
  const [mode, setMode] = useState('paste'); // 'paste', 'quick', 'ai'
  const [pasteInput, setPasteInput] = useState('');
  const [quickAnswers, setQuickAnswers] = useState({});
  const [currentQuickIndex, setCurrentQuickIndex] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [parsePreview, setParsePreview] = useState([]);

  const questionsNeedingAnswers = quiz.questions.filter(q => 
    ['multiple_choice', 'multiple_select', 'true_false'].includes(q.type) && !q.options?.some(opt => opt.isCorrect)
  );

  // Parse preview when paste input changes
  useEffect(() => {
    if (pasteInput.trim()) {
      const parsed = parseAnswerKey(pasteInput, quiz.questions.length);
      setParsePreview(parsed);
    } else {
      setParsePreview([]);
    }
  }, [pasteInput, quiz.questions.length]);

  const handleApplyPaste = () => {
    const parsed = parseAnswerKey(pasteInput, quiz.questions.length);
    onApply(parsed);
  };

  const handleApplyQuick = () => {
    const answers = [];
    Object.entries(quickAnswers).forEach(([index, answer]) => {
      answers[parseInt(index)] = answer;
    });
    onApply(answers);
  };

  const handleQuickSelect = (answer) => {
    setQuickAnswers(prev => ({ ...prev, [currentQuickIndex]: answer }));
    // Auto-advance to next question needing answer
    const nextIndex = questionsNeedingAnswers.findIndex((q, i) => i > currentQuickIndex && !quickAnswers[i]);
    if (nextIndex >= 0) {
      setCurrentQuickIndex(nextIndex);
    } else if (currentQuickIndex < questionsNeedingAnswers.length - 1) {
      setCurrentQuickIndex(currentQuickIndex + 1);
    }
  };

  const generateAISuggestions = async () => {
    if (!apiKey || !callAnthropicProxy) return;
    setIsGenerating(true);

    try {
      const questionsText = questionsNeedingAnswers.map((q, i) => {
        const originalIndex = quiz.questions.findIndex(oq => oq.id === q.id);
        let text = `${originalIndex + 1}. ${q.text}\n`;
        if (q.options) {
          text += q.options.map(opt => `   ${opt.id.toUpperCase()}) ${opt.text}`).join('\n');
        }
        return text;
      }).join('\n\n');

      const data = await callAnthropicProxy({
        model: MODEL_SONNET,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are helping a teacher create an answer key. For each question below, provide the most likely correct answer.

IMPORTANT: Only output the answers in this exact format, one per line:
1-B
2-A
3-True
etc.

Do not include explanations. Just the question number, a dash, and the answer letter or True/False.

Questions:
${questionsText}`
        }]
      });

      const aiAnswers = data.content[0].text;
      setPasteInput(aiAnswers);
      setMode('paste');
    } catch (err) {
      console.error('AI generation error:', err);
    }

    setIsGenerating(false);
  };

  const answeredCount = Object.keys(quickAnswers).length;
  const previewCount = parsePreview.filter(a => a).length;

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.answerKeyModalContent} onClick={(e) => e.stopPropagation()}>
        <button style={styles.modalClose} onClick={onClose}><X size={20} /></button>
        
        <div style={styles.answerKeyHeader}>
          <div style={styles.answerKeyIcon}><Key size={28} color="#f59e0b" /></div>
          <h2 style={styles.answerKeyTitle}>Answer Key Assistant</h2>
          <p style={styles.answerKeySubtitle}>
            {questionsNeedingAnswers.length} of {quiz.questions.length} questions need correct answers
          </p>
        </div>

        {/* Mode Tabs */}
        <div style={styles.modeTabs}>
          <button style={{ ...styles.modeTab, ...(mode === 'paste' && styles.modeTabActive) }} onClick={() => setMode('paste')}>
            <ClipboardList size={18} />
            Paste Answer Key
          </button>
          <button style={{ ...styles.modeTab, ...(mode === 'quick' && styles.modeTabActive) }} onClick={() => setMode('quick')}>
            <Zap size={18} />
            Quick Entry
          </button>
          {apiKey && (
            <button style={{ ...styles.modeTab, ...(mode === 'ai' && styles.modeTabActive) }} onClick={() => setMode('ai')}>
              <Brain size={18} />
              AI Suggestions
            </button>
          )}
        </div>

        {/* Paste Mode */}
        {mode === 'paste' && (
          <div style={styles.answerKeySection}>
            <p style={styles.answerKeyHelp}>
              Paste your answer key in any format — we'll figure it out:
            </p>
            <div style={styles.formatExamples}>
              <code>1-B, 2-A, 3-C</code>
              <code>1.B 2.A 3.C</code>
              <code>B, A, C, D</code>
              <code>BACDC</code>
            </div>
            <textarea
              style={styles.answerKeyTextarea}
              value={pasteInput}
              onChange={(e) => setPasteInput(e.target.value)}
              placeholder="Paste answer key here..."
              rows={4}
            />
            {previewCount > 0 && (
              <div style={styles.parsePreview}>
                <CheckCircle2 size={16} color="#10b981" />
                <span>Detected {previewCount} answers: </span>
                <span style={styles.previewAnswers}>
                  {parsePreview.slice(0, 10).map((a, i) => a ? `${i + 1}-${a}` : null).filter(Boolean).join(', ')}
                  {previewCount > 10 && '...'}
                </span>
              </div>
            )}
            <button
              style={{ ...styles.applyButton, opacity: previewCount === 0 ? 0.5 : 1 }}
              onClick={handleApplyPaste}
              disabled={previewCount === 0}
            >
              <Check size={18} />
              Apply {previewCount} Answers
            </button>
          </div>
        )}

        {/* Quick Entry Mode */}
        {mode === 'quick' && (
          <div style={styles.answerKeySection}>
            <p style={styles.answerKeyHelp}>
              Click the correct answer for each question:
            </p>
            
            {questionsNeedingAnswers.length > 0 && (
              <div style={styles.quickEntryCard}>
                <div style={styles.quickEntryHeader}>
                  <span style={styles.quickQuestionNumber}>
                    Question {quiz.questions.findIndex(q => q.id === questionsNeedingAnswers[currentQuickIndex].id) + 1}
                  </span>
                  <span style={styles.quickProgress}>
                    {answeredCount} of {questionsNeedingAnswers.length} answered
                  </span>
                </div>
                <p style={styles.quickQuestionText}>
                  {questionsNeedingAnswers[currentQuickIndex].text.length > 150 
                    ? questionsNeedingAnswers[currentQuickIndex].text.substring(0, 150) + '...'
                    : questionsNeedingAnswers[currentQuickIndex].text}
                </p>
                <div style={styles.quickOptions}>
                  {questionsNeedingAnswers[currentQuickIndex].options?.map(opt => (
                    <button
                      key={opt.id}
                      style={{
                        ...styles.quickOption,
                        ...(quickAnswers[currentQuickIndex] === opt.id.toUpperCase() && styles.quickOptionSelected),
                      }}
                      onClick={() => handleQuickSelect(opt.id.toUpperCase())}
                    >
                      <span style={styles.quickOptionLetter}>{opt.id.toUpperCase()}</span>
                      <span style={styles.quickOptionText}>{opt.text}</span>
                    </button>
                  ))}
                </div>
                <div style={styles.quickNavigation}>
                  <button
                    style={styles.quickNavButton}
                    onClick={() => setCurrentQuickIndex(Math.max(0, currentQuickIndex - 1))}
                    disabled={currentQuickIndex === 0}
                  >
                    <ChevronLeft size={18} /> Previous
                  </button>
                  <div style={styles.quickDots}>
                    {questionsNeedingAnswers.slice(0, 15).map((_, i) => (
                      <button
                        key={i}
                        style={{
                          ...styles.quickDot,
                          ...(currentQuickIndex === i && styles.quickDotActive),
                          ...(quickAnswers[i] && styles.quickDotAnswered),
                        }}
                        onClick={() => setCurrentQuickIndex(i)}
                      />
                    ))}
                    {questionsNeedingAnswers.length > 15 && <span>...</span>}
                  </div>
                  <button
                    style={styles.quickNavButton}
                    onClick={() => setCurrentQuickIndex(Math.min(questionsNeedingAnswers.length - 1, currentQuickIndex + 1))}
                    disabled={currentQuickIndex === questionsNeedingAnswers.length - 1}
                  >
                    Next <ChevronRight size={18} />
                  </button>
                </div>
              </div>
            )}
            
            <button
              style={{ ...styles.applyButton, opacity: answeredCount === 0 ? 0.5 : 1 }}
              onClick={handleApplyQuick}
              disabled={answeredCount === 0}
            >
              <Check size={18} />
              Apply {answeredCount} Answers
            </button>
          </div>
        )}

        {/* AI Mode */}
        {mode === 'ai' && (
          <div style={styles.answerKeySection}>
            <div style={styles.aiWarning}>
              <AlertTriangle size={18} />
              <span>AI suggestions are experimental. Always verify answers before using.</span>
            </div>
            <p style={styles.answerKeyHelp}>
              Let AI analyze your questions and suggest likely correct answers based on the content.
            </p>
            <button
              style={{ ...styles.generateButton, opacity: isGenerating ? 0.7 : 1 }}
              onClick={generateAISuggestions}
              disabled={isGenerating}
            >
              {isGenerating ? (
                <>
                  <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
                  Generating...
                </>
              ) : (
                <>
                  <Brain size={18} />
                  Generate AI Suggestions
                </>
              )}
            </button>
            <p style={styles.aiNote}>
              Suggestions will appear in the "Paste Answer Key" tab for review.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// OTHER COMPONENTS (Settings, Preview, Export, Modals)
// ============================================================================

function SettingsStep({ settings, onChange, onBack, onNext }) {
  return (
    <div style={styles.settingsStep}>
      <div style={styles.settingsCard}>
        <h2 style={styles.settingsTitle}>Quiz Settings</h2>
        <p style={styles.settingsSubtitle}>Configure how your quiz will behave in Canvas</p>
        <div style={styles.settingsGrid}>
          <div style={styles.settingField}>
            <label style={styles.settingLabel}>Quiz Title</label>
            <input type="text" style={styles.settingInput} value={settings.title} onChange={(e) => onChange({ ...settings, title: e.target.value })} />
          </div>
          <div style={{ ...styles.settingField, gridColumn: 'span 2' }}>
            <label style={styles.settingLabel}>Description</label>
            <textarea style={styles.settingTextarea} value={settings.description} onChange={(e) => onChange({ ...settings, description: e.target.value })} rows={3} />
          </div>
          <div style={styles.settingField}>
            <label style={styles.settingLabel}>Time Limit (min)</label>
            <input type="number" style={styles.settingInput} value={settings.timeLimit} onChange={(e) => onChange({ ...settings, timeLimit: parseInt(e.target.value) || 0 })} min={0} />
          </div>
          <div style={styles.settingField}>
            <label style={styles.settingLabel}>Attempts</label>
            <input type="number" style={styles.settingInput} value={settings.attemptsAllowed} onChange={(e) => onChange({ ...settings, attemptsAllowed: parseInt(e.target.value) || 1 })} min={1} />
          </div>
        </div>
        <div style={styles.settingsActions}>
          <button style={styles.backButton} onClick={onBack}><ChevronLeft size={18} />Back</button>
          <button style={styles.continueButton} onClick={onNext}>Preview<ChevronRight size={18} /></button>
        </div>
      </div>
    </div>
  );
}

function ToggleOption({ label, checked, onChange }) {
  return (
    <button style={{ ...styles.toggleOption, ...(checked && styles.toggleOptionActive) }} onClick={() => onChange(!checked)}>
      {checked ? <CheckSquare size={18} color="#0b4901" /> : <Square size={18} color="#9ca3af" />}
      <span>{label}</span>
    </button>
  );
}

function PreviewStep({ quiz, settings, onBack, onNext }) {
  const [currentQ, setCurrentQ] = useState(0);
  const currentQuestion = quiz.questions[currentQ];
  const hasRichText = containsMath(currentQuestion.text) || containsMarkdown(currentQuestion.text);

  return (
    <div style={styles.previewStep}>
      <div style={styles.previewHeader}>
        <div>
          <h2 style={styles.previewTitle}>{settings.title}</h2>
          <p style={styles.previewMeta}>{quiz.questions.length} questions • {quiz.questions.reduce((a, q) => a + (q.points || 0), 0)} points</p>
        </div>
      </div>
      <div style={styles.previewCard}>
        <div style={styles.previewCardHeader}>
          <span style={styles.previewQuestionNumber}>Question {currentQ + 1} of {quiz.questions.length}</span>
          <span style={styles.previewPoints}>{currentQuestion.points} pts</span>
        </div>
        <div style={styles.previewQuestionText}>
          {hasRichText ? (
            <RichTextRenderer text={currentQuestion.text} />
          ) : (
            currentQuestion.text
          )}
        </div>
        {currentQuestion.images?.length > 0 && (
          <div style={styles.previewImagesContainer}>
            {currentQuestion.images.map((img, i) => (
              <img key={img.id} src={img.dataUrl} alt={`Q${currentQ + 1} img ${i + 1}`} style={styles.previewQuestionImage} />
            ))}
          </div>
        )}
        {['multiple_choice', 'multiple_select', 'true_false'].includes(currentQuestion.type) && (
          <div style={styles.previewOptions}>
            {currentQuestion.options.map(opt => {
              const optHasRichText = containsMath(opt.text) || containsMarkdown(opt.text);
              return (
                <div key={opt.id} style={{ ...styles.previewOption, ...(opt.isCorrect && styles.previewOptionCorrect) }}>
                  <div style={{ ...styles.previewOptionCircle, ...(opt.isCorrect && styles.previewOptionCircleCorrect) }}>
                    {opt.isCorrect && <Check size={12} color="#fff" />}
                  </div>
                  <span style={styles.previewOptionText}>
                    {optHasRichText ? <RichTextRenderer text={opt.text} inline /> : opt.text}
                  </span>
                  {opt.isCorrect && <span style={styles.correctBadge}>Correct</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div style={styles.previewNavigation}>
        <button style={styles.previewNavButton} onClick={() => setCurrentQ(Math.max(0, currentQ - 1))} disabled={currentQ === 0}>
          <ChevronLeft size={20} />Prev
        </button>
        <div style={styles.previewDots}>
          {quiz.questions.slice(0, 12).map((_, i) => (
            <button key={i} style={{ ...styles.previewDot, ...(currentQ === i && styles.previewDotActive) }} onClick={() => setCurrentQ(i)} />
          ))}
          {quiz.questions.length > 12 && <span style={{ color: '#9ca3af' }}>...</span>}
        </div>
        <button style={styles.previewNavButton} onClick={() => setCurrentQ(Math.min(quiz.questions.length - 1, currentQ + 1))} disabled={currentQ === quiz.questions.length - 1}>
          Next<ChevronRight size={20} />
        </button>
      </div>
      <div style={styles.previewActions}>
        <button style={styles.backButton} onClick={onBack}><ChevronLeft size={18} />Back</button>
        <button style={styles.continueButton} onClick={onNext}>Export<ChevronRight size={18} /></button>
      </div>
    </div>
  );
}

function ExportStep({ quiz, settings, onDownload, onBack }) {
  const [showSuccess, setShowSuccess] = useState(false);
  const totalImages = quiz.questions.reduce((a, q) => a + (q.images?.length || 0), 0);
  const answeredCount = quiz.questions.filter(q => ['multiple_choice', 'true_false'].includes(q.type) && q.options?.some(o => o.isCorrect)).length;

  const handleDownload = () => { onDownload(); setShowSuccess(true); setTimeout(() => setShowSuccess(false), 3000); };

  return (
    <div style={styles.exportStep}>
      <div style={styles.exportCard}>
        <div style={styles.exportIcon}><Download size={48} color="#0b4901" /></div>
        <h2 style={styles.exportTitle}>Export Your Quiz</h2>
        <div style={styles.exportSummary}>
          <h3 style={styles.exportSummaryTitle}>{settings.title}</h3>
          <div style={styles.exportStats}>
            <div style={styles.exportStat}><span style={styles.exportStatValue}>{quiz.questions.length}</span><span style={styles.exportStatLabel}>Questions</span></div>
            <div style={styles.exportStat}><span style={styles.exportStatValue}>{answeredCount}</span><span style={styles.exportStatLabel}>With Answers</span></div>
            <div style={styles.exportStat}><span style={{ ...styles.exportStatValue, color: '#10b981' }}>{totalImages}</span><span style={styles.exportStatLabel}>Images</span></div>
          </div>
        </div>
        {showSuccess && <div style={styles.successMessage}><CheckCircle2 size={20} /><span>Downloaded successfully!</span></div>}
        <div style={styles.exportActions}>
          <button style={styles.backButton} onClick={onBack}><ChevronLeft size={18} />Back</button>
          <button style={styles.downloadButton} onClick={handleDownload}><Download size={20} />Download QTI File</button>
        </div>
        <div style={styles.importInstructions}>
          <h4 style={styles.instructionsTitle}>Import to Canvas:</h4>
          <ol style={styles.instructionsList}>
            <li>Go to Canvas course → Settings → Import</li>
            <li>Select "QTI .zip file"</li>
            <li>Upload and import</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

function ApiKeyModal({ apiKey, onSave, onClose }) {
  const [key, setKey] = useState(apiKey);
  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <button style={styles.modalClose} onClick={onClose}><X size={20} /></button>
        <div style={styles.modalIcon}><Sparkles size={32} color="#0b4901" /></div>
        <h2 style={styles.modalTitle}>Connect AI</h2>
        <p style={styles.modalDesc}>Enter your Anthropic API key for advanced parsing and answer suggestions.</p>
        <div style={styles.modalField}>
          <label style={styles.modalLabel}>API Key</label>
          <input type="password" style={styles.modalInput} value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-..." />
        </div>
        <div style={styles.modalActions}>
          <button style={styles.modalCancelButton} onClick={onClose}>Cancel</button>
          <button style={styles.modalSaveButton} onClick={() => { onSave(key); onClose(); }}>{key ? 'Save' : 'Demo Mode'}</button>
        </div>
      </div>
    </div>
  );
}

function ImagePreviewModal({ image, onClose }) {
  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.imagePreviewModal} onClick={(e) => e.stopPropagation()}>
        <button style={styles.modalClose} onClick={onClose}><X size={24} /></button>
        <img src={image.dataUrl} alt={image.filename || 'Preview'} style={styles.fullImagePreview} />
      </div>
    </div>
  );
}

// ============================================================================
// RICH TEXT RENDERER - Markdown + LaTeX Math
// ============================================================================

function RichTextRenderer({ text, inline = false }) {
  const [renderedContent, setRenderedContent] = useState(text);
  const [isReady, setIsReady] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    let mounted = true;

    async function renderContent() {
      if (!text) {
        setRenderedContent('');
        setIsReady(true);
        return;
      }

      try {
        await loadRichTextLibraries();

        if (!mounted) return;

        // Step 1: Extract and protect math blocks
        const mathBlocks = [];
        let processedText = text;

        // Extract display math ($$...$$)
        processedText = processedText.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
          const id = `__MATH_DISPLAY_${mathBlocks.length}__`;
          mathBlocks.push({ id, math: math.trim(), display: true });
          return id;
        });

        // Extract inline math ($...$) - be careful not to match $$ or currency
        processedText = processedText.replace(/(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g, (match, math) => {
          const id = `__MATH_INLINE_${mathBlocks.length}__`;
          mathBlocks.push({ id, math: math.trim(), display: false });
          return id;
        });

        // Step 2: Process markdown (if marked is available)
        if (window.marked) {
          // Configure marked for safe output
          window.marked.setOptions({
            gfm: true,
            breaks: true,
          });
          processedText = window.marked.parse(processedText);
        } else {
          // Basic markdown fallback
          processedText = processedText
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br />');
        }

        // Step 3: Render math and replace placeholders
        for (const block of mathBlocks) {
          try {
            const rendered = window.katex.renderToString(block.math, {
              displayMode: block.display,
              throwOnError: false,
              output: 'html',
            });
            processedText = processedText.replace(block.id, rendered);
          } catch (e) {
            // If KaTeX fails, show the original math with error styling
            const errorHtml = `<span style="color: #ef4444; background: #fef2f2; padding: 2px 4px; border-radius: 4px; font-family: monospace;">${block.display ? '$$' : '$'}${block.math}${block.display ? '$$' : '$'}</span>`;
            processedText = processedText.replace(block.id, errorHtml);
          }
        }

        if (mounted) {
          setRenderedContent(processedText);
          setIsReady(true);
        }
      } catch (error) {
        console.error('Error rendering rich text:', error);
        if (mounted) {
          // Fallback to plain text with basic escaping
          setRenderedContent(text.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
          setIsReady(true);
        }
      }
    }

    renderContent();

    return () => {
      mounted = false;
    };
  }, [text]);

  if (!isReady) {
    return <span style={styles.richTextLoading}>Loading...</span>;
  }

  if (inline) {
    return (
      <span
        ref={containerRef}
        style={styles.richTextInline}
        dangerouslySetInnerHTML={{ __html: renderedContent }}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      style={styles.richTextBlock}
      dangerouslySetInnerHTML={{ __html: renderedContent }}
    />
  );
}

// ============================================================================
// STYLES
// ============================================================================

const styles = {
  container: { minHeight: '100vh', backgroundColor: '#f8fafc', fontFamily: "'DM Sans', -apple-system, sans-serif", position: 'relative' },
  bgPattern: { position: 'absolute', top: 0, left: 0, right: 0, height: '400px', background: 'linear-gradient(135deg, #062d01 0%, #0b4901 100%)', opacity: 0.05, pointerEvents: 'none' },
  header: { backgroundColor: '#fff', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, zIndex: 100 },
  headerContent: { maxWidth: '1400px', margin: '0 auto', padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '24px', flexWrap: 'wrap' },
  logo: { display: 'flex', alignItems: 'center', gap: '10px' },
  logoIcon: { width: '36px', height: '36px', borderRadius: '8px', background: 'linear-gradient(135deg, #0b4901, #084301)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  logoText: { fontSize: '20px', fontWeight: '700', color: '#1e293b' },
  versionBadge: { fontSize: '10px', fontWeight: '600', color: '#fff', backgroundColor: '#10b981', padding: '2px 6px', borderRadius: '4px' },
  progressSteps: { display: 'flex', alignItems: 'center', gap: '8px' },
  stepButton: { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', border: 'none', borderRadius: '6px', backgroundColor: 'transparent', color: '#64748b', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  stepButtonActive: { backgroundColor: '#e8f5e6', color: '#0b4901' },
  stepButtonComplete: { color: '#10b981' },
  stepLabel: {},
  stepConnector: { width: '20px', height: '2px', borderRadius: '1px' },
  headerActions: { display: 'flex', alignItems: 'center', gap: '12px' },
  apiKeyButton: { display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', border: '1px solid #e5e7eb', borderRadius: '8px', backgroundColor: '#fff', color: '#374151', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  usageIndicator: { display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', border: '1px solid #d1fae5', borderRadius: '8px', backgroundColor: '#ecfdf5', color: '#047857', fontSize: '13px', fontWeight: '500' },
  resetButton: { display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', border: 'none', borderRadius: '8px', backgroundColor: '#fef2f2', color: '#dc2626', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  main: { maxWidth: '1400px', margin: '0 auto', padding: '24px' },

  // Upload
  uploadStep: { maxWidth: '800px', margin: '0 auto' },
  uploadHero: { textAlign: 'center', marginBottom: '32px' },
  heroTitle: { fontSize: '32px', fontWeight: '700', color: '#1e293b', marginBottom: '12px', lineHeight: 1.2 },
  heroSubtitle: { fontSize: '16px', color: '#64748b', lineHeight: 1.6 },
  errorBanner: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '10px', color: '#dc2626', marginBottom: '24px', fontSize: '14px' },
  warningBanner: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', backgroundColor: '#fffbeb', border: '1px solid #fde68a', borderRadius: '10px', color: '#92400e', marginBottom: '24px', fontSize: '14px' },
  rateLimitBanner: { display: 'flex', alignItems: 'center', gap: '10px', padding: '16px 20px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '12px', color: '#dc2626', fontSize: '14px', marginBottom: '20px' },
  rateLimitWarning: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 16px', backgroundColor: '#fffbeb', borderRadius: '8px', color: '#92400e', fontSize: '13px', marginBottom: '16px' },
  uploadContainer: { display: 'flex', flexDirection: 'column', gap: '20px' },
  dropZone: { border: '2px dashed #d1d5db', borderRadius: '16px', padding: '48px 24px', textAlign: 'center', cursor: 'pointer', transition: 'all 0.3s ease', backgroundColor: '#fff' },
  dropZoneDragging: { borderColor: '#0b4901', backgroundColor: '#e8f5e6' },
  dropZoneWithFile: { borderStyle: 'solid', borderColor: '#0b4901', padding: '24px', cursor: 'default' },
  uploadIcon: { width: '80px', height: '80px', margin: '0 auto 16px', borderRadius: '50%', backgroundColor: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' },
  dropText: { fontSize: '16px', color: '#64748b', marginBottom: '12px', lineHeight: 1.6 },
  dropTextBold: { fontWeight: '600', color: '#374151' },
  supportedFormatsRow: { display: 'flex', justifyContent: 'center', gap: '12px', marginTop: '8px' },
  formatBadge: { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', backgroundColor: '#f1f5f9', borderRadius: '6px', fontSize: '12px', color: '#64748b', fontWeight: '500' },
  filePreviewContainer: { display: 'flex', flexDirection: 'column', gap: '16px' },
  filePreview: { display: 'flex', alignItems: 'center', gap: '16px' },
  fileIcon: { width: '56px', height: '56px', borderRadius: '12px', backgroundColor: '#e8f5e6', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  fileInfo: { flex: 1, textAlign: 'left' },
  fileName: { display: 'block', fontSize: '15px', fontWeight: '600', color: '#1e293b' },
  fileSize: { fontSize: '13px', color: '#64748b' },
  removeFileButton: { width: '36px', height: '36px', borderRadius: '8px', border: 'none', backgroundColor: '#fef2f2', color: '#dc2626', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  fileListHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: '8px' },
  fileListTitle: { fontSize: '14px', fontWeight: '600', color: '#374151' },
  fileListActions: { display: 'flex', gap: '8px' },
  addMoreButton: { display: 'flex', alignItems: 'center', gap: '4px', padding: '6px 12px', border: '1px solid #0b4901', borderRadius: '6px', backgroundColor: '#e8f5e6', color: '#0b4901', fontSize: '12px', fontWeight: '500', cursor: 'pointer' },
  clearAllButton: { display: 'flex', alignItems: 'center', gap: '4px', padding: '6px 12px', border: '1px solid #dc2626', borderRadius: '6px', backgroundColor: '#fef2f2', color: '#dc2626', fontSize: '12px', fontWeight: '500', cursor: 'pointer' },
  fileList: { display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto', width: '100%' },
  fileListItem: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #e5e7eb' },
  fileListItemIcon: { width: '36px', height: '36px', borderRadius: '8px', backgroundColor: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #e5e7eb' },
  fileListItemInfo: { flex: 1, minWidth: 0, textAlign: 'left' },
  fileListItemName: { display: 'block', fontSize: '13px', fontWeight: '500', color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  fileListItemSize: { fontSize: '11px', color: '#64748b' },
  fileListItemRemove: { width: '28px', height: '28px', borderRadius: '6px', border: 'none', backgroundColor: 'transparent', color: '#9ca3af', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  processingIndicator: { display: 'flex', alignItems: 'center', gap: '8px', color: '#0b4901', fontSize: '13px' },
  extractedTextPreview: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#10b981' },
  extractedImagesPreview: { borderTop: '1px solid #e5e7eb', paddingTop: '16px' },
  extractedImagesHeader: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: '500', color: '#10b981', marginBottom: '12px' },
  extractedImagesThumbs: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  extractedThumb: { width: '60px', height: '60px', borderRadius: '8px', overflow: 'hidden', border: '2px solid #e5e7eb' },
  extractedThumbImg: { width: '100%', height: '100%', objectFit: 'cover' },
  extractedThumbMore: { width: '60px', height: '60px', borderRadius: '8px', backgroundColor: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: '600', color: '#64748b' },
  importedQuizSummary: { borderTop: '1px solid #e5e7eb', paddingTop: '16px', marginTop: '8px' },
  importedQuizHeader: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: '500', color: '#8b5cf6', marginBottom: '8px' },
  importedQuizItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', backgroundColor: '#f5f3ff', borderRadius: '6px', marginBottom: '4px' },
  importedQuizTitle: { fontSize: '13px', fontWeight: '500', color: '#4c1d95' },
  importedQuizCount: { fontSize: '12px', color: '#7c3aed', backgroundColor: '#ede9fe', padding: '2px 8px', borderRadius: '10px' },
  divider: { display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dividerText: { fontSize: '13px', color: '#9ca3af', fontWeight: '500' },
  textInputToggle: { display: 'flex', alignItems: 'center', gap: '12px', width: '100%', padding: '16px 20px', border: '1px solid #e5e7eb', borderRadius: '12px', backgroundColor: '#fff', color: '#374151', fontSize: '15px', fontWeight: '500', cursor: 'pointer' },
  textInputToggleActive: { borderColor: '#0b4901', backgroundColor: '#f8fafc' },
  textInputContainer: { position: 'relative' },
  textArea: { width: '100%', padding: '16px', border: '1px solid #e5e7eb', borderRadius: '12px', fontSize: '14px', lineHeight: 1.6, resize: 'vertical', fontFamily: 'monospace', backgroundColor: '#fff', boxSizing: 'border-box' },
  loadSampleButton: { position: 'absolute', bottom: '12px', right: '12px', display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 12px', border: 'none', borderRadius: '6px', backgroundColor: '#fef3c7', color: '#92400e', fontSize: '12px', fontWeight: '500', cursor: 'pointer' },
  processButtonContainer: { marginTop: '32px', textAlign: 'center' },
  processButton: { display: 'inline-flex', alignItems: 'center', gap: '10px', padding: '16px 32px', border: 'none', borderRadius: '12px', background: 'linear-gradient(135deg, #0b4901, #084301)', color: '#fff', fontSize: '16px', fontWeight: '600', cursor: 'pointer', boxShadow: '0 4px 14px rgba(11, 73, 1, 0.4)' },
  demoNote: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', marginTop: '12px', fontSize: '13px', color: '#64748b' },
  features: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '24px', marginTop: '48px', paddingTop: '48px', borderTop: '1px solid #e5e7eb' },
  feature: { textAlign: 'center' },
  featureIcon: { width: '56px', height: '56px', margin: '0 auto 12px', borderRadius: '12px', backgroundColor: '#e8f5e6', color: '#0b4901', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  featureTitle: { fontSize: '15px', fontWeight: '600', color: '#1e293b', marginBottom: '6px' },
  featureDesc: { fontSize: '13px', color: '#64748b', lineHeight: 1.5 },

  // Processing
  processingStep: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' },
  processingCard: { backgroundColor: '#fff', borderRadius: '20px', padding: '48px', textAlign: 'center', boxShadow: '0 4px 24px rgba(0, 0, 0, 0.08)', maxWidth: '500px', width: '100%' },
  processingIcon: { width: '80px', height: '80px', margin: '0 auto 24px', borderRadius: '50%', background: 'linear-gradient(135deg, #e8f5e6, #d4edd1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0b4901' },
  processingTitle: { fontSize: '24px', fontWeight: '700', color: '#1e293b', marginBottom: '8px' },
  processingStatus: { fontSize: '15px', color: '#64748b', marginBottom: '16px' },
  imageCountBadge: { display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '8px 16px', backgroundColor: '#ecfdf5', borderRadius: '20px', color: '#10b981', fontSize: '13px', fontWeight: '500', marginBottom: '24px' },
  progressBarContainer: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '32px' },
  progressBarBg: { flex: 1, height: '8px', backgroundColor: '#e5e7eb', borderRadius: '4px', overflow: 'hidden' },
  progressBarFill: { height: '100%', background: 'linear-gradient(90deg, #0b4901, #084301)', borderRadius: '4px', transition: 'width 0.3s ease' },
  progressPercent: { fontSize: '14px', fontWeight: '600', color: '#0b4901', minWidth: '45px' },
  processingSteps: { display: 'flex', flexDirection: 'column', gap: '12px', textAlign: 'left' },
  processingStepItem: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px' },

  // Edit
  editStep: { display: 'flex', flexDirection: 'column', gap: '20px' },
  summaryBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: '12px', padding: '16px 24px', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)', flexWrap: 'wrap', gap: '16px' },
  summaryStats: { display: 'flex', alignItems: 'center', gap: '24px', flexWrap: 'wrap' },
  statItem: { display: 'flex', flexDirection: 'column' },
  statValue: { fontSize: '24px', fontWeight: '700', color: '#1e293b' },
  statLabel: { fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px' },
  statDivider: { width: '1px', height: '40px', backgroundColor: '#e5e7eb' },
  summaryActions: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  answerKeyButton: { display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 16px', border: '2px solid #f59e0b', borderRadius: '10px', backgroundColor: '#fffbeb', color: '#92400e', fontSize: '13px', fontWeight: '600', cursor: 'pointer' },
  continueButton: { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 20px', border: 'none', borderRadius: '10px', background: 'linear-gradient(135deg, #0b4901, #084301)', color: '#fff', fontSize: '14px', fontWeight: '600', cursor: 'pointer' },
  answerKeyFoundBanner: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 20px', backgroundColor: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '10px', color: '#059669', fontSize: '14px', fontWeight: '500' },
  editLayout: { display: 'grid', gridTemplateColumns: '320px 1fr', gap: '24px', minHeight: '600px' },
  questionList: { backgroundColor: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  questionListHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #e5e7eb' },
  questionListTitle: { fontSize: '14px', fontWeight: '600', color: '#374151', textTransform: 'uppercase', letterSpacing: '0.5px' },
  addQuestionButton: { width: '32px', height: '32px', borderRadius: '8px', border: 'none', backgroundColor: '#e8f5e6', color: '#0b4901', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  questionListScroll: { flex: 1, overflow: 'auto', padding: '8px' },
  questionListItem: { display: 'flex', alignItems: 'center', gap: '12px', width: '100%', padding: '12px', border: '1px solid transparent', borderRadius: '10px', backgroundColor: 'transparent', cursor: 'pointer', textAlign: 'left', marginBottom: '4px' },
  questionListItemSelected: { backgroundColor: '#e8f5e6', borderColor: '#0b4901' },
  questionListItemWarning: { backgroundColor: '#fffbeb' },
  questionListItemLeft: { display: 'flex', alignItems: 'center', gap: '8px' },
  questionNumber: { fontSize: '12px', fontWeight: '600', color: '#9ca3af', minWidth: '20px' },
  questionListItemContent: { flex: 1, minWidth: 0 },
  questionPreviewText: { fontSize: '13px', color: '#374151', marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  questionMetaRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  questionTypeLabel: { fontSize: '11px', color: '#9ca3af' },
  imageIndicator: { display: 'flex', alignItems: 'center', gap: '3px', fontSize: '11px', color: '#10b981', backgroundColor: '#ecfdf5', padding: '2px 6px', borderRadius: '4px' },
  needsAnswerIndicator: { display: 'flex', alignItems: 'center', padding: '2px 6px', backgroundColor: '#fef3c7', borderRadius: '4px', color: '#f59e0b' },
  questionEditor: { backgroundColor: '#fff', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)', overflow: 'hidden' },
  noQuestionSelected: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af', gap: '12px' },

  // Editor
  editorContainer: { padding: '24px', maxHeight: '75vh', overflow: 'auto' },
  editorHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' },
  editorNav: { display: 'flex', alignItems: 'center', gap: '8px' },
  navButton: { width: '36px', height: '36px', borderRadius: '8px', border: '1px solid #e5e7eb', backgroundColor: '#fff', color: '#374151', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  questionCounter: { fontSize: '14px', fontWeight: '600', color: '#374151' },
  deleteButton: { display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', border: 'none', borderRadius: '8px', backgroundColor: '#fef2f2', color: '#dc2626', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  warningsContainer: { marginBottom: '20px' },
  warningItem: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', backgroundColor: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', color: '#92400e', fontSize: '13px', marginBottom: '8px' },
  editorField: { marginBottom: '20px' },
  editorFieldRow: { display: 'flex', gap: '20px', marginBottom: '20px' },
  editorFieldSmall: { flex: '0 0 120px' },
  fieldLabel: { display: 'block', fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' },
  fieldHint: { fontWeight: '400', textTransform: 'none', letterSpacing: 'normal', color: '#64748b' },
  typeSelector: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  typeOption: { display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: '8px', backgroundColor: '#fff', cursor: 'pointer', fontSize: '12px', fontWeight: '500', color: '#374151' },
  typeOptionSelected: { backgroundColor: '#e8f5e6' },
  questionTextArea: { width: '100%', padding: '12px 16px', border: '1px solid #e5e7eb', borderRadius: '10px', fontSize: '15px', lineHeight: 1.6, resize: 'vertical', boxSizing: 'border-box' },
  pointsInput: { width: '100%', padding: '12px 16px', border: '1px solid #e5e7eb', borderRadius: '10px', fontSize: '15px', boxSizing: 'border-box' },
  imageGrid: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
  imageCard: { position: 'relative', width: '100px', height: '80px', borderRadius: '8px', overflow: 'hidden', border: '1px solid #e5e7eb' },
  imagePreviewWrapper: { width: '100%', height: '100%', cursor: 'pointer' },
  imagePreview: { width: '100%', height: '100%', objectFit: 'cover' },
  removeImageButton: { position: 'absolute', top: '4px', right: '4px', width: '20px', height: '20px', borderRadius: '4px', border: 'none', backgroundColor: 'rgba(239, 68, 68, 0.9)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  addImageCard: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px', width: '100px', height: '80px', border: '2px dashed #d1d5db', borderRadius: '8px', backgroundColor: 'transparent', cursor: 'pointer', color: '#9ca3af', fontSize: '11px' },
  imageDropZone: { display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 20px', border: '2px dashed #d1d5db', borderRadius: '10px', backgroundColor: '#f8fafc', cursor: 'pointer' },
  imageDropText: { fontSize: '13px', color: '#64748b' },
  optionsList: { display: 'flex', flexDirection: 'column', gap: '10px' },
  optionItem: { display: 'flex', alignItems: 'center', gap: '12px' },
  correctToggle: { width: '36px', height: '36px', borderRadius: '8px', border: 'none', backgroundColor: '#f8fafc', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  correctToggleActive: { backgroundColor: '#ecfdf5' },
  optionLetter: { fontSize: '14px', fontWeight: '600', color: '#64748b', minWidth: '24px' },
  optionInput: { flex: 1, padding: '12px 16px', border: '1px solid #e5e7eb', borderRadius: '10px', fontSize: '14px' },
  removeOptionButton: { width: '36px', height: '36px', borderRadius: '8px', border: 'none', backgroundColor: '#fef2f2', color: '#dc2626', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  addOptionButton: { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', border: '1px dashed #d1d5db', borderRadius: '10px', backgroundColor: 'transparent', color: '#64748b', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },

  // Settings
  settingsStep: { display: 'flex', justifyContent: 'center', padding: '24px 0' },
  settingsCard: { backgroundColor: '#fff', borderRadius: '16px', padding: '32px', boxShadow: '0 4px 24px rgba(0, 0, 0, 0.08)', maxWidth: '700px', width: '100%' },
  settingsTitle: { fontSize: '24px', fontWeight: '700', color: '#1e293b', marginBottom: '8px' },
  settingsSubtitle: { fontSize: '15px', color: '#64748b', marginBottom: '32px' },
  settingsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' },
  settingField: {},
  settingLabel: { display: 'block', fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '8px' },
  settingInput: { width: '100%', padding: '12px 16px', border: '1px solid #e5e7eb', borderRadius: '10px', fontSize: '14px', boxSizing: 'border-box' },
  settingTextarea: { width: '100%', padding: '12px 16px', border: '1px solid #e5e7eb', borderRadius: '10px', fontSize: '14px', resize: 'vertical', boxSizing: 'border-box' },
  toggleGrid: { display: 'flex', flexWrap: 'wrap', gap: '12px' },
  toggleOption: { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#fff', cursor: 'pointer', fontSize: '14px', color: '#374151' },
  toggleOptionActive: { borderColor: '#0b4901', backgroundColor: '#e8f5e6' },
  settingsActions: { display: 'flex', justifyContent: 'space-between', marginTop: '32px', paddingTop: '24px', borderTop: '1px solid #e5e7eb' },
  backButton: { display: 'flex', alignItems: 'center', gap: '6px', padding: '12px 20px', border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#fff', color: '#374151', fontSize: '14px', fontWeight: '500', cursor: 'pointer' },

  // Preview
  previewStep: { maxWidth: '800px', margin: '0 auto' },
  previewHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' },
  previewTitle: { fontSize: '24px', fontWeight: '700', color: '#1e293b', marginBottom: '4px' },
  previewMeta: { fontSize: '14px', color: '#64748b' },
  previewCard: { backgroundColor: '#fff', borderRadius: '16px', padding: '32px', boxShadow: '0 4px 24px rgba(0, 0, 0, 0.08)', marginBottom: '20px' },
  previewCardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' },
  previewQuestionNumber: { fontSize: '13px', fontWeight: '600', color: '#64748b', textTransform: 'uppercase' },
  previewPoints: { fontSize: '13px', color: '#0b4901', fontWeight: '600' },
  previewQuestionText: { fontSize: '18px', color: '#1e293b', lineHeight: 1.6, marginBottom: '20px' },
  previewImagesContainer: { display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '24px' },
  previewQuestionImage: { maxWidth: '100%', maxHeight: '250px', borderRadius: '8px', border: '1px solid #e5e7eb' },
  previewOptions: { display: 'flex', flexDirection: 'column', gap: '12px' },
  previewOption: { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px', border: '1px solid #e5e7eb', borderRadius: '10px' },
  previewOptionCorrect: { borderColor: '#10b981', backgroundColor: '#ecfdf5' },
  previewOptionCircle: { width: '20px', height: '20px', borderRadius: '50%', border: '2px solid #d1d5db', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  previewOptionCircleCorrect: { backgroundColor: '#10b981', borderColor: '#10b981' },
  correctBadge: { marginLeft: 'auto', fontSize: '12px', fontWeight: '600', color: '#10b981' },
  previewNavigation: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '32px' },
  previewNavButton: { display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 16px', border: '1px solid #e5e7eb', borderRadius: '8px', backgroundColor: '#fff', color: '#374151', fontSize: '13px', fontWeight: '500', cursor: 'pointer' },
  previewDots: { display: 'flex', gap: '8px', alignItems: 'center' },
  previewDot: { width: '10px', height: '10px', borderRadius: '50%', border: 'none', backgroundColor: '#e5e7eb', cursor: 'pointer' },
  previewDotActive: { backgroundColor: '#0b4901' },
  previewActions: { display: 'flex', justifyContent: 'space-between' },

  // Export
  exportStep: { display: 'flex', justifyContent: 'center', padding: '24px 0' },
  exportCard: { backgroundColor: '#fff', borderRadius: '16px', padding: '48px', boxShadow: '0 4px 24px rgba(0, 0, 0, 0.08)', maxWidth: '550px', width: '100%', textAlign: 'center' },
  exportIcon: { width: '80px', height: '80px', margin: '0 auto 24px', borderRadius: '50%', backgroundColor: '#e8f5e6', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  exportTitle: { fontSize: '28px', fontWeight: '700', color: '#1e293b', marginBottom: '24px' },
  exportSummary: { backgroundColor: '#f8fafc', borderRadius: '12px', padding: '24px', marginBottom: '24px' },
  exportSummaryTitle: { fontSize: '18px', fontWeight: '600', color: '#1e293b', marginBottom: '16px' },
  exportStats: { display: 'flex', justifyContent: 'center', gap: '32px' },
  exportStat: { display: 'flex', flexDirection: 'column' },
  exportStatValue: { fontSize: '28px', fontWeight: '700', color: '#0b4901' },
  exportStatLabel: { fontSize: '12px', color: '#64748b', textTransform: 'uppercase' },
  successMessage: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '12px 20px', backgroundColor: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '10px', color: '#059669', marginBottom: '24px', fontSize: '14px', fontWeight: '500' },
  exportActions: { display: 'flex', justifyContent: 'center', gap: '16px', marginBottom: '32px', flexWrap: 'wrap' },
  downloadButton: { display: 'flex', alignItems: 'center', gap: '10px', padding: '16px 32px', border: 'none', borderRadius: '12px', background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', fontSize: '16px', fontWeight: '600', cursor: 'pointer', boxShadow: '0 4px 14px rgba(16, 185, 129, 0.4)' },
  importInstructions: { textAlign: 'left', padding: '20px', backgroundColor: '#f8fafc', borderRadius: '10px' },
  instructionsTitle: { fontSize: '14px', fontWeight: '600', color: '#374151', marginBottom: '12px' },
  instructionsList: { fontSize: '13px', color: '#64748b', lineHeight: 1.8, paddingLeft: '20px', margin: 0 },

  // Modal
  modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px' },
  modal: { backgroundColor: '#fff', borderRadius: '16px', padding: '32px', maxWidth: '450px', width: '100%', position: 'relative', textAlign: 'center' },
  modalClose: { position: 'absolute', top: '16px', right: '16px', width: '32px', height: '32px', borderRadius: '8px', border: 'none', backgroundColor: '#f1f5f9', color: '#64748b', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modalIcon: { width: '64px', height: '64px', margin: '0 auto 20px', borderRadius: '50%', backgroundColor: '#e8f5e6', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modalTitle: { fontSize: '20px', fontWeight: '700', color: '#1e293b', marginBottom: '8px' },
  modalDesc: { fontSize: '14px', color: '#64748b', lineHeight: 1.6, marginBottom: '24px' },
  modalField: { textAlign: 'left', marginBottom: '24px' },
  modalLabel: { display: 'block', fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '8px' },
  modalInput: { width: '100%', padding: '12px 16px', border: '1px solid #e5e7eb', borderRadius: '10px', fontSize: '14px', boxSizing: 'border-box' },
  modalActions: { display: 'flex', gap: '12px' },
  modalCancelButton: { flex: 1, padding: '12px 20px', border: '1px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#fff', color: '#374151', fontSize: '14px', fontWeight: '500', cursor: 'pointer' },
  modalSaveButton: { flex: 1, padding: '12px 20px', border: 'none', borderRadius: '10px', background: 'linear-gradient(135deg, #0b4901, #084301)', color: '#fff', fontSize: '14px', fontWeight: '600', cursor: 'pointer' },
  imagePreviewModal: { backgroundColor: '#000', borderRadius: '16px', padding: '16px', maxWidth: '90vw', maxHeight: '90vh', position: 'relative' },
  fullImagePreview: { maxWidth: '100%', maxHeight: 'calc(90vh - 60px)', objectFit: 'contain', borderRadius: '8px' },

  // Answer Key Modal
  answerKeyModalContent: { backgroundColor: '#fff', borderRadius: '20px', padding: '32px', maxWidth: '600px', width: '100%', position: 'relative', maxHeight: '90vh', overflow: 'auto' },
  answerKeyHeader: { textAlign: 'center', marginBottom: '24px' },
  answerKeyIcon: { width: '64px', height: '64px', margin: '0 auto 16px', borderRadius: '50%', backgroundColor: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  answerKeyTitle: { fontSize: '22px', fontWeight: '700', color: '#1e293b', marginBottom: '8px' },
  answerKeySubtitle: { fontSize: '14px', color: '#64748b' },
  modeTabs: { display: 'flex', gap: '8px', marginBottom: '24px', borderBottom: '1px solid #e5e7eb', paddingBottom: '16px' },
  modeTab: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', border: 'none', borderRadius: '8px', backgroundColor: '#f1f5f9', color: '#64748b', fontSize: '13px', fontWeight: '500', cursor: 'pointer', flex: 1, justifyContent: 'center' },
  modeTabActive: { backgroundColor: '#0b4901', color: '#fff' },
  answerKeySection: { marginBottom: '24px' },
  answerKeyHelp: { fontSize: '14px', color: '#64748b', marginBottom: '12px' },
  formatExamples: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' },
  answerKeyTextarea: { width: '100%', padding: '16px', border: '1px solid #e5e7eb', borderRadius: '10px', fontSize: '14px', fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box', marginBottom: '12px' },
  parsePreview: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#10b981', marginBottom: '16px', flexWrap: 'wrap' },
  previewAnswers: { fontFamily: 'monospace', backgroundColor: '#ecfdf5', padding: '4px 8px', borderRadius: '4px' },
  applyButton: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', width: '100%', padding: '14px 24px', border: 'none', borderRadius: '10px', background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', fontSize: '15px', fontWeight: '600', cursor: 'pointer' },
  quickEntryCard: { backgroundColor: '#f8fafc', borderRadius: '12px', padding: '20px', marginBottom: '20px' },
  quickEntryHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  quickQuestionNumber: { fontSize: '14px', fontWeight: '600', color: '#0b4901' },
  quickProgress: { fontSize: '12px', color: '#64748b' },
  quickQuestionText: { fontSize: '15px', color: '#1e293b', lineHeight: 1.5, marginBottom: '16px' },
  quickOptions: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' },
  quickOption: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', border: '2px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#fff', cursor: 'pointer', textAlign: 'left' },
  quickOptionSelected: { borderColor: '#10b981', backgroundColor: '#ecfdf5' },
  quickOptionLetter: { width: '28px', height: '28px', borderRadius: '6px', backgroundColor: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: '600', color: '#374151', flexShrink: 0 },
  quickOptionText: { fontSize: '14px', color: '#374151' },
  quickNavigation: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  quickNavButton: { display: 'flex', alignItems: 'center', gap: '4px', padding: '8px 12px', border: 'none', borderRadius: '6px', backgroundColor: '#e5e7eb', color: '#374151', fontSize: '12px', fontWeight: '500', cursor: 'pointer' },
  quickDots: { display: 'flex', gap: '6px', alignItems: 'center' },
  quickDot: { width: '8px', height: '8px', borderRadius: '50%', border: 'none', backgroundColor: '#e5e7eb', cursor: 'pointer' },
  quickDotActive: { backgroundColor: '#0b4901' },
  quickDotAnswered: { backgroundColor: '#10b981' },
  aiWarning: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 16px', backgroundColor: '#fef3c7', border: '1px solid #fde68a', borderRadius: '8px', color: '#92400e', fontSize: '13px', marginBottom: '16px' },
  generateButton: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', width: '100%', padding: '14px 24px', border: 'none', borderRadius: '10px', background: 'linear-gradient(135deg, #8b5cf6, #7c3aed)', color: '#fff', fontSize: '15px', fontWeight: '600', cursor: 'pointer', marginBottom: '12px' },
  aiNote: { fontSize: '12px', color: '#64748b', textAlign: 'center' },

  // Mode Selector (Parse vs Generate)
  modeSelector: { backgroundColor: '#fff', borderBottom: '1px solid #e5e7eb', padding: '12px 0' },
  modeSelectorContent: { maxWidth: '1400px', margin: '0 auto', padding: '0 24px', display: 'flex', justifyContent: 'center', gap: '8px' },
  modeTabMain: { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px', border: '2px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#fff', color: '#64748b', fontSize: '14px', fontWeight: '500', cursor: 'pointer', transition: 'all 0.2s ease' },
  modeTabMainActive: { borderColor: '#0b4901', backgroundColor: '#e8f5e6', color: '#0b4901' },

  // Generate Step
  generateStep: { maxWidth: '1100px', margin: '0 auto' },
  generateLayout: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' },
  generateSourceSection: { backgroundColor: '#fff', borderRadius: '16px', padding: '24px', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)' },
  generateConfigSection: { display: 'flex', flexDirection: 'column', gap: '16px' },
  generateSectionTitle: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '16px', fontWeight: '600', color: '#1e293b', marginBottom: '16px' },

  // Page Range
  pageRangeSection: { marginTop: '20px', padding: '16px', backgroundColor: '#f8fafc', borderRadius: '10px' },
  pageRangeLabel: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: '500', color: '#374151', marginBottom: '12px' },
  pageRangeInputs: { display: 'flex', alignItems: 'center', gap: '12px' },
  pageRangeInput: { width: '80px', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', textAlign: 'center' },
  pageRangeTo: { fontSize: '14px', color: '#64748b' },
  pageRangeHint: { fontSize: '12px', color: '#9ca3af', marginTop: '8px' },

  // Config Cards
  configCard: { backgroundColor: '#fff', borderRadius: '12px', padding: '20px', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)' },
  configCardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' },
  configCardTitle: { fontSize: '14px', fontWeight: '600', color: '#374151' },
  totalQuestionsLabel: { fontSize: '13px', fontWeight: '500', color: '#0b4901', backgroundColor: '#e8f5e6', padding: '4px 10px', borderRadius: '6px' },

  // Question Types Grid (Generate Mode)
  questionTypesGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' },
  questionTypeRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', backgroundColor: '#f8fafc', borderRadius: '8px' },
  questionTypeInfo: { display: 'flex', alignItems: 'center', gap: '8px' },
  genQuestionTypeLabel: { fontSize: '13px', color: '#374151' },
  questionTypeInput: { width: '60px', padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: '6px', fontSize: '14px', textAlign: 'center' },

  // Difficulty Options
  difficultyOptions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  difficultyButton: { padding: '10px 18px', border: '2px solid #e5e7eb', borderRadius: '8px', backgroundColor: '#fff', color: '#64748b', fontSize: '13px', fontWeight: '500', cursor: 'pointer', transition: 'all 0.2s ease' },
  difficultyButtonActive: { borderColor: '#0b4901', backgroundColor: '#e8f5e6', color: '#0b4901' },

  // Bloom's Taxonomy
  bloomsGrid: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  bloomsButton: { display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', border: '2px solid #e5e7eb', borderRadius: '8px', backgroundColor: '#fff', color: '#64748b', fontSize: '13px', fontWeight: '500', cursor: 'pointer', transition: 'all 0.2s ease' },
  bloomsButtonActive: { borderColor: '#10b981', backgroundColor: '#ecfdf5', color: '#059669' },
  bloomsSelectedCount: { fontSize: '12px', color: '#64748b' },

  // Additional Options
  optionsColumn: { display: 'flex', flexDirection: 'column', gap: '16px' },
  checkboxLabel: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px', color: '#374151', cursor: 'pointer' },
  checkbox: { width: '18px', height: '18px', accentColor: '#0b4901' },
  selectField: { display: 'flex', flexDirection: 'column', gap: '8px' },
  selectLabel: { fontSize: '13px', fontWeight: '500', color: '#64748b' },
  selectInput: { padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '14px', color: '#374151', backgroundColor: '#fff', cursor: 'pointer' },

  // Math Toolbar & Rich Text Styles
  fieldLabelRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' },
  editPreviewToggle: { display: 'flex', gap: '4px', backgroundColor: '#f1f5f9', borderRadius: '6px', padding: '2px' },
  toggleButton: { padding: '6px 12px', border: 'none', borderRadius: '4px', backgroundColor: 'transparent', color: '#64748b', fontSize: '12px', fontWeight: '500', cursor: 'pointer' },
  toggleButtonActive: { backgroundColor: '#fff', color: '#0b4901', boxShadow: '0 1px 2px rgba(0,0,0,0.1)' },
  mathToolbar: { display: 'flex', alignItems: 'center', gap: '4px', padding: '8px 12px', backgroundColor: '#f8fafc', borderRadius: '8px 8px 0 0', border: '1px solid #e5e7eb', borderBottom: 'none', flexWrap: 'wrap' },
  mathToolbarButton: { padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: '4px', backgroundColor: '#fff', color: '#374151', fontSize: '13px', fontWeight: '500', cursor: 'pointer', fontFamily: 'serif' },
  mathToolbarHint: { marginLeft: 'auto', fontSize: '11px', color: '#9ca3af', fontStyle: 'italic' },
  questionPreviewBox: { padding: '16px', backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', minHeight: '100px', fontSize: '15px', lineHeight: 1.6, color: '#1e293b' },
  questionPreviewText: { margin: 0, whiteSpace: 'pre-wrap' },

  // Rich Text Renderer Styles
  richTextLoading: { color: '#9ca3af', fontStyle: 'italic', fontSize: '13px' },
  richTextInline: { display: 'inline' },
  richTextBlock: { lineHeight: 1.6 },
  previewOptionText: { flex: 1 },
};

// CSS animations
const styleSheet = document.createElement('style');
styleSheet.textContent = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  * { box-sizing: border-box; }
  input:focus, textarea:focus { outline: none; border-color: #0b4901 !important; box-shadow: 0 0 0 3px rgba(11, 73, 1, 0.1); }
  button:hover { opacity: 0.95; }
  code { padding: 4px 8px; background: #f1f5f9; border-radius: 4px; font-size: 12px; color: #64748b; }
`;
document.head.appendChild(styleSheet);

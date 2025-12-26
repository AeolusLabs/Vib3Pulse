import sanitizeHtml from 'sanitize-html';
import dns from 'dns';
import { promisify } from 'util';

const dnsLookup = promisify(dns.lookup);

interface LinkPreviewMetadata {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  domain: string;
  favicon: string | null;
}

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^fc00:/i,
  /^fe80:/i,
  /^::1$/,
  /^localhost$/i,
  /^.*\.local$/i,
];

const BLOCKED_HOSTS = [
  'localhost',
  '0.0.0.0',
  'metadata.google.internal',
  'instance-data',
];

const MAX_RESPONSE_SIZE = 500 * 1024;
const FETCH_TIMEOUT = 5000;
const MAX_REDIRECTS = 3;

const linkPreviewCache = new Map<string, { data: LinkPreviewMetadata; timestamp: number }>();
const CACHE_TTL = 60 * 60 * 1000;

function isPrivateIPString(ip: string): boolean {
  return PRIVATE_IP_RANGES.some(pattern => pattern.test(ip));
}

function isPrivateIP(hostname: string): boolean {
  const lowerHost = hostname.toLowerCase();
  
  if (BLOCKED_HOSTS.some(blocked => lowerHost === blocked || lowerHost.endsWith(`.${blocked}`))) {
    return true;
  }
  
  return PRIVATE_IP_RANGES.some(pattern => pattern.test(hostname));
}

async function resolveAndValidateHost(hostname: string): Promise<boolean> {
  try {
    const result = await dnsLookup(hostname, { all: true });
    const addresses = Array.isArray(result) ? result : [result];
    
    for (const addr of addresses) {
      const ip = typeof addr === 'string' ? addr : addr.address;
      if (isPrivateIPString(ip)) {
        console.warn(`DNS resolution blocked: ${hostname} resolves to private IP ${ip}`);
        return false;
      }
    }
    return true;
  } catch (error) {
    console.warn(`DNS resolution failed for ${hostname}:`, error);
    return false;
  }
}

function validateUrl(urlString: string): { valid: boolean; url?: URL; error?: string } {
  try {
    const url = new URL(urlString);
    
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: 'Only HTTP/HTTPS URLs are allowed' };
    }
    
    if (isPrivateIP(url.hostname)) {
      return { valid: false, error: 'Private/internal URLs are not allowed' };
    }
    
    if (url.port && !['80', '443', ''].includes(url.port)) {
      return { valid: false, error: 'Non-standard ports are not allowed' };
    }
    
    if (url.username || url.password) {
      return { valid: false, error: 'URLs with credentials are not allowed' };
    }
    
    return { valid: true, url };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function extractMetaContent(html: string, property: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, 'i'),
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return sanitizeHtml(match[1], { allowedTags: [], allowedAttributes: {} }).trim();
    }
  }
  return null;
}

function extractTitle(html: string): string | null {
  const ogTitle = extractMetaContent(html, 'og:title');
  if (ogTitle) return ogTitle;
  
  const twitterTitle = extractMetaContent(html, 'twitter:title');
  if (twitterTitle) return twitterTitle;
  
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    return sanitizeHtml(titleMatch[1], { allowedTags: [], allowedAttributes: {} }).trim();
  }
  
  return null;
}

function extractDescription(html: string): string | null {
  const ogDesc = extractMetaContent(html, 'og:description');
  if (ogDesc) return ogDesc;
  
  const twitterDesc = extractMetaContent(html, 'twitter:description');
  if (twitterDesc) return twitterDesc;
  
  const metaDesc = extractMetaContent(html, 'description');
  if (metaDesc) return metaDesc;
  
  return null;
}

function extractImage(html: string, baseUrl: string): string | null {
  const ogImage = extractMetaContent(html, 'og:image');
  if (ogImage) {
    return resolveUrl(ogImage, baseUrl);
  }
  
  const twitterImage = extractMetaContent(html, 'twitter:image');
  if (twitterImage) {
    return resolveUrl(twitterImage, baseUrl);
  }
  
  return null;
}

function extractSiteName(html: string): string | null {
  return extractMetaContent(html, 'og:site_name') || 
         extractMetaContent(html, 'twitter:site') ||
         null;
}

function extractFavicon(html: string, baseUrl: string): string | null {
  const iconPatterns = [
    /<link[^>]+rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:icon|shortcut icon|apple-touch-icon)["']/i,
  ];
  
  for (const pattern of iconPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return resolveUrl(match[1], baseUrl);
    }
  }
  
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}/favicon.ico`;
  } catch {
    return null;
  }
}

function resolveUrl(url: string, base: string): string {
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

export async function fetchLinkPreview(urlString: string): Promise<LinkPreviewMetadata | null> {
  const cached = linkPreviewCache.get(urlString);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  
  const validation = validateUrl(urlString);
  if (!validation.valid || !validation.url) {
    console.warn(`Link preview validation failed for ${urlString}: ${validation.error}`);
    return null;
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  
  try {
    let currentUrl = urlString;
    let redirectCount = 0;
    
    while (redirectCount < MAX_REDIRECTS) {
      const currentUrlParsed = new URL(currentUrl);
      
      const dnsValid = await resolveAndValidateHost(currentUrlParsed.hostname);
      if (!dnsValid) {
        console.warn(`Link preview blocked: DNS resolution indicates private IP for ${currentUrlParsed.hostname}`);
        return null;
      }
      
      const response = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'VibePulse-LinkPreview/1.0 (compatible; bot)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
        redirect: 'manual',
      });
      
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) break;
        
        const redirectValidation = validateUrl(resolveUrl(location, currentUrl));
        if (!redirectValidation.valid) {
          console.warn(`Redirect blocked to ${location}: ${redirectValidation.error}`);
          return null;
        }
        
        currentUrl = resolveUrl(location, currentUrl);
        redirectCount++;
        continue;
      }
      
      if (!response.ok) {
        return null;
      }
      
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return null;
      }
      
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
        return null;
      }
      
      let html = '';
      const reader = response.body?.getReader();
      if (!reader) return null;
      
      let bytesRead = 0;
      const decoder = new TextDecoder();
      
      try {
        while (bytesRead < MAX_RESPONSE_SIZE) {
          const { done, value } = await reader.read();
          if (done) break;
          
          bytesRead += value.length;
          
          if (bytesRead > MAX_RESPONSE_SIZE) {
            await reader.cancel();
            console.warn(`Link preview aborted: response exceeded ${MAX_RESPONSE_SIZE} bytes`);
            return null;
          }
          
          html += decoder.decode(value, { stream: true });
          
          if (html.includes('</head>')) {
            await reader.cancel();
            break;
          }
        }
      } catch (streamError) {
        console.warn(`Link preview stream error:`, streamError);
        return null;
      }
      
      const metadata: LinkPreviewMetadata = {
        url: currentUrl,
        title: extractTitle(html),
        description: extractDescription(html),
        image: extractImage(html, currentUrl),
        siteName: extractSiteName(html),
        domain: extractDomain(currentUrl),
        favicon: extractFavicon(html, currentUrl),
      };
      
      linkPreviewCache.set(urlString, { data: metadata, timestamp: Date.now() });
      
      return metadata;
    }
    
    return null;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.warn(`Link preview fetch timeout for ${urlString}`);
    } else {
      console.error(`Link preview fetch error for ${urlString}:`, error.message);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function clearLinkPreviewCache(): void {
  linkPreviewCache.clear();
}

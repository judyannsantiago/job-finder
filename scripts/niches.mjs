// Niche (industry or specialty) detection. Edit the keyword lists to tune it.
// A title match counts 3x. A job needs a title match or 2+ mentions in the description to get a niche.
export const NICHES = [
  ['E-commerce', /e-?commerce|shopify|amazon (seller|fba|store)|woocommerce|online store|order management|dropship/i],
  ['Real Estate and Property', /real estate|realtor|property manag|mortgage|leasing|listing agent/i],
  ['Healthcare and Medical', /healthcare|medical|patient|dental|clinic|pharmacy|telehealth|hipaa/i],
  ['Finance and Bookkeeping', /bookkeep|accounting|accounts (payable|receivable)|quickbooks|payroll|invoic|collections|banking|insurance/i],
  ['Marketing and Social Media', /social media|content (creator|writer|marketing)|\bseo\b|email marketing|community manager|digital marketing|copywrit/i],
  ['Sales and Lead Generation', /lead gen|appointment setting|cold call|outbound sales|\bsdr\b|\bbdr\b|telemarketing/i],
  ['Tech and SaaS Support', /saas|technical support|it help ?desk|tier [123]|troubleshoot/i],
  ['Home Services and Field Operations', /hvac|plumb|roofing|field service|work order|contractor|electrician|home services|pest control|dispatch/i],
  ['Logistics, Procurement and Vendors', /logistics|freight|shipping|supply chain|procurement|purchase order|warehouse|vendor|supplier|inventory/i],
  ['Legal and Compliance', /legal|paralegal|law firm|attorney|compliance/i],
  ['Travel, Hospitality and Rentals', /travel|hotel|hospitality|reservations?|car rental|airline|tour operator/i],
  ['Education and Training', /tutor|teacher|e-?learning|student|school|training specialist/i],
  ['Recruitment and HR', /recruit|talent acquisition|human resources|\bhr\b/i],
];
export const DEFAULT_NICHE = 'General (any industry)';
export function detectNiche(title, text) {
  let best = DEFAULT_NICHE, bestScore = 1;
  for (const [name, re] of NICHES) {
    const g = new RegExp(re.source, 'gi');
    const s = (title.match(g) || []).length * 3 + Math.min(5, (text.match(g) || []).length);
    if (s > bestScore) { best = name; bestScore = s; }
  }
  return best;
}

// =============================================================================
// LLM EXTRACTION VERIFICATION - VALIDATION & QUALITY PROMPTS
// Embedding-based verification: find the source chunks most relevant to each
// extracted field, then verify the extraction against them with an LLM to
// catch hallucinated or unsupported values before they reach the database.
// =============================================================================

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export interface FieldToValidate {
  field_path: string;
  extracted_value: string | number | boolean | null;
  field_type: 'number' | 'string' | 'date' | 'boolean' | 'array' | 'object';
  importance: 'critical' | 'high' | 'medium' | 'low';
}

export interface ChunkMatch {
  chunk_id: string;
  chunk_text: string;
  page_number: number | null;
  similarity_score: number;
  /** Actual uploaded file name for citations (e.g. "Legal_Report.pdf") */
  filename?: string;
}

export interface FieldVerification {
  field_path: string;
  extracted_value: string;
  is_supported: boolean;
  support_type: 'explicit' | 'implicit' | 'calculated' | 'unsupported';
  confidence: number;
  source_page: number | null;
  source_quote: string | null;
  notes: string | null;
}

export interface ValidationResult {
  document_id: string;
  dd_type: string;
  overall_confidence: number;
  field_verifications: FieldVerification[];
  hallucination_flags: string[];
  completeness_score: number;
  verified_at: string;
}

// -----------------------------------------------------------------------------
// QUERY BUILDERS - Convert extracted fields to embedding search queries
// -----------------------------------------------------------------------------

const FIELD_SYNONYMS: Record<string, string> = {
  'maintainable_ebitda': 'Adjusted EBITDA Normalized Pro-Forma Recurring',
  'normalized_ebitda': 'Adjusted EBITDA Pro-Forma Recurring',
  'ebitda_adjustments': 'Due Diligence Adjustments Normalizations Add-backs One-offs',
  'nwc_normalized': 'Net Working Capital Target NWC Peg Average',
  'churn_retention': 'Attrition Renewal Rate Net Dollar Retention NDR',
  'churn': 'Attrition Cancellations',
  'ltv_cac': 'Unit Economics LTV/CAC Lifetime Value',
  'gross_margin': 'Gross Profit Margin',
  'customer_concentration': 'Top Customers Key Accounts Concentration Risk',
  'historical_revenue': 'Sales Turnover Revenue Growth',
  'tam': 'Total Addressable Market Market Size',
  'sam': 'Serviceable Addressable Market',
};

/**
 * Build a search query from a field path and value
 * Goal: create a query that will find the chunk containing this data
 */
export function buildSearchQuery(fieldPath: string, value: unknown): string {
  const fieldName = fieldPath.split('.').pop() || fieldPath;
  const humanReadable = fieldName.replace(/_/g, ' ');

  // For freeform text fields (rag, contradiction, risk), use the value directly
  // without prepending the field name — the prefix word dilutes embedding alignment
  const PASSTHROUGH_FIELDS = new Set(['rag', 'contradiction', 'risk']);
  if (PASSTHROUGH_FIELDS.has(fieldName) && typeof value === 'string') {
    return value.length > 200 ? value.slice(0, 200) : value;
  }
  
  // Add synonyms to improve recall
  const synonyms = FIELD_SYNONYMS[fieldName] || '';
  const searchTerms = synonyms ? `${humanReadable} ${synonyms}` : humanReadable;
  
  if (value === null || value === undefined) {
    return searchTerms;
  }
  
  if (typeof value === 'number') {
    // For numbers, include various formats
    const formatted = formatNumber(value);
    return `${searchTerms} ${formatted}`;
  }
  
  if (typeof value === 'boolean') {
    return `${searchTerms} ${value ? 'yes' : 'no'}`;
  }
  
  if (typeof value === 'string') {
    // Truncate long strings
    const truncated = value.length > 100 ? value.slice(0, 100) : value;
    return `${searchTerms} ${truncated}`;
  }
  
  if (Array.isArray(value)) {
    // For arrays, extract meaningful values from objects to create a better search query
    // Use keywords, largest numbers, and names
    const items = value.slice(0, 5); // Increased slice to 5
    
    const terms = items.map(v => {
      if (typeof v === 'object' && v !== null) {
        return Object.entries(v)
          .filter(([k, val]) => {
            // Keep keys that sound like labels/names
            const isLabel = /name|description|type|category|customer|competitor|supplier/.test(k);
            // Keep values that are strings or numbers
            const t = typeof val;
            const isVal = (t === 'number') || (t === 'string' && (val as string).length < 50);
            return isLabel || isVal;
          })
          .map(([_, val]) => String(val))
          .join(' ');
      }
      return String(v);
    }).join(' ');

    const cleanPreview = terms.replace(/[{}[\],":]/g, ' ').replace(/\s+/g, ' ').trim();
    return `${searchTerms} ${cleanPreview}`;
  }

  // Handle plain objects (that aren't arrays or null)
  if (typeof value === 'object' && value !== null) {
    const preview = Object.values(value)
      .filter(val => {
        const t = typeof val;
        return (t === 'number') || (t === 'string' && (val as string).length < 50);
      })
      .join(' ');
    
    const cleanPreview = preview.replace(/[{}[\],":]/g, ' ').replace(/\s+/g, ' ').trim();
    return `${searchTerms} ${cleanPreview}`;
  }
  
  return searchTerms;
}


function formatNumber(n: number): string {
  const raw = String(n);
  const withCommas = Number.isFinite(n) ? n.toLocaleString() : raw;
  return raw === withCommas ? raw : `${raw} ${withCommas}`;
}

// -----------------------------------------------------------------------------
// CRITICAL FIELDS BY DD TYPE - What must be verified
// -----------------------------------------------------------------------------

export const CRITICAL_FIELDS: Record<string, FieldToValidate[]> = {
  legal: [
    { field_path: 'entity_structure.parent_entity', extracted_value: '', field_type: 'string', importance: 'critical' },
    { field_path: 'entity_structure.subsidiaries', extracted_value: '', field_type: 'array', importance: 'critical' },
    { field_path: 'cap_table', extracted_value: '', field_type: 'array', importance: 'critical' },
    { field_path: 'shareholder_agreements', extracted_value: '', field_type: 'array', importance: 'high' },
    { field_path: 'litigation', extracted_value: '', field_type: 'array', importance: 'critical' },
    { field_path: 'material_contracts', extracted_value: '', field_type: 'array', importance: 'high' },
    { field_path: 'compliance_status', extracted_value: '', field_type: 'array', importance: 'high' },
    { field_path: 'ip_portfolio', extracted_value: '', field_type: 'array', importance: 'medium' },
    { field_path: 'real_estate', extracted_value: '', field_type: 'array', importance: 'medium' },
    { field_path: 'employment_matters.key_employee_contracts', extracted_value: '', field_type: 'array', importance: 'medium' },
  ],
  financial: [
    { field_path: 'revenue_analysis.historical_revenue', extracted_value: '', field_type: 'array', importance: 'critical' },
    { field_path: 'revenue_analysis.revenue_cagr_3yr', extracted_value: '', field_type: 'number', importance: 'high' },
    { field_path: 'revenue_analysis.revenue_by_customer', extracted_value: '', field_type: 'array', importance: 'high' },
    { field_path: 'profitability_analysis.normalized_ebitda', extracted_value: '', field_type: 'number', importance: 'critical' },
    { field_path: 'profitability_analysis.ebitda_adjustments', extracted_value: '', field_type: 'array', importance: 'critical' },
    { field_path: 'profitability_analysis.reported_ebitda', extracted_value: '', field_type: 'number', importance: 'high' },
    { field_path: 'working_capital.nwc_normalized', extracted_value: '', field_type: 'number', importance: 'high' },
    { field_path: 'working_capital.historical_nwc', extracted_value: '', field_type: 'array', importance: 'medium' },
    { field_path: 'debt_structure.total_debt', extracted_value: '', field_type: 'number', importance: 'critical' },
    { field_path: 'debt_structure.net_debt', extracted_value: '', field_type: 'number', importance: 'critical' },
    { field_path: 'debt_structure.covenant_headroom', extracted_value: '', field_type: 'object', importance: 'high' },
    { field_path: 'qoe_summary.maintainable_ebitda', extracted_value: '', field_type: 'number', importance: 'critical' },
    { field_path: 'cash_flow_analysis.historical_ocf', extracted_value: '', field_type: 'array', importance: 'medium' },
  ],
  commercial: [
    { field_path: 'market_size.tam', extracted_value: '', field_type: 'number', importance: 'critical' },
    { field_path: 'market_size.sam', extracted_value: '', field_type: 'number', importance: 'high' },
    { field_path: 'market_size.growth_rate_projected', extracted_value: '', field_type: 'number', importance: 'high' },
    { field_path: 'competitive_landscape.competitors', extracted_value: '', field_type: 'array', importance: 'critical' },
    { field_path: 'competitive_landscape.company_market_share', extracted_value: '', field_type: 'number', importance: 'high' },
    { field_path: 'customer_analysis.customer_concentration', extracted_value: '', field_type: 'object', importance: 'critical' },
    { field_path: 'customer_analysis.top_customers', extracted_value: '', field_type: 'array', importance: 'high' },
    { field_path: 'customer_analysis.churn_retention', extracted_value: '', field_type: 'object', importance: 'high' },
    { field_path: 'unit_economics.ltv_cac_ratio', extracted_value: '', field_type: 'number', importance: 'high' },
    { field_path: 'go_to_market.sales_channels', extracted_value: '', field_type: 'array', importance: 'medium' },
  ],
  esg: [
    { field_path: 'ghg_emissions.scope_1', extracted_value: '', field_type: 'object', importance: 'critical' },
    { field_path: 'ghg_emissions.scope_2', extracted_value: '', field_type: 'object', importance: 'critical' },
    { field_path: 'ghg_emissions.scope_3', extracted_value: '', field_type: 'object', importance: 'high' },
    { field_path: 'sfdr_alignment.article_classification', extracted_value: '', field_type: 'string', importance: 'critical' },
    { field_path: 'sfdr_alignment.pai_indicators', extracted_value: '', field_type: 'array', importance: 'high' },
    { field_path: 'ifc_ps_assessment', extracted_value: '', field_type: 'object', importance: 'high' },
    { field_path: 'social_metrics.employee_count', extracted_value: '', field_type: 'number', importance: 'medium' },
    { field_path: 'governance_metrics.board_size', extracted_value: '', field_type: 'number', importance: 'medium' },
  ],
  tech: [
    { field_path: 'technology_stack.languages', extracted_value: '', field_type: 'array', importance: 'critical' },
    { field_path: 'technology_stack.cloud_provider', extracted_value: '', field_type: 'string', importance: 'high' },
    { field_path: 'system_architecture.architecture_type', extracted_value: '', field_type: 'string', importance: 'critical' },
    { field_path: 'system_architecture.scalability', extracted_value: '', field_type: 'object', importance: 'high' },
    { field_path: 'security_posture.certifications', extracted_value: '', field_type: 'array', importance: 'critical' },
    { field_path: 'security_posture.vulnerabilities', extracted_value: '', field_type: 'array', importance: 'critical' },
    { field_path: 'technical_debt', extracted_value: '', field_type: 'array', importance: 'high' },
    { field_path: 'it_organization.team_size', extracted_value: '', field_type: 'number', importance: 'medium' },
    { field_path: 'development_practices.ci_cd', extracted_value: '', field_type: 'object', importance: 'medium' },
  ],
};

// -----------------------------------------------------------------------------
// FIELD VERIFICATION PROMPT - Verify ONE field against relevant chunks
// -----------------------------------------------------------------------------

export const FIELD_VERIFICATION_SYSTEM_PROMPT = `You are a verification analyst checking if extracted fields are supported by source documents.

Your goal is to VALIDATE the data, not to find reasons to reject it.
If the extracted data is *plausible* given the text, mark it as SUPPORTED.

Definitions:
- EXPLICIT = Exact or near-exact match found.
- IMPLICIT = Value implied, summarized, or strictly synonymous (e.g. "Adj. EBITDA" vs "Normalized EBITDA").
- CALCULATED = Value is a sum or ratio of found numbers (e.g. EBITDA = Op Profit + Deprec).
- UNSUPPORTED = The value CONTRADICTS the text or is completely completely absent.

**CRITICAL INSTRUCTION**: If you find the concept in the text but the value differs slightly (rounding, different year, currency conversion), or the terminology differs, mark as SUPPORTED (Implicit) and note the discrepancy.`;

export const FIELD_VERIFICATION_USER_PROMPT = `Verify this extracted data against the source chunks.

**FIELD:** {{FIELD_PATH}}
**EXTRACTED VALUE:** {{EXTRACTED_VALUE}}

**RELEVANT SOURCE CHUNKS:**
{{CHUNKS}}

**YOUR TASK:** Determine if the extracted value is supported by these chunks.

**OUTPUT FORMAT:** Return ONLY valid JSON:

{
  "is_supported": <true|false>,
  "support_type": "<explicit|implicit|calculated|unsupported>",
  "confidence": <0.0-1.0>,
  "source_page": <page number where found, or null>,
  "source_quote": "<exact quote that supports this, max 200 chars, or null>",
  "notes": "<explanation of your verification, especially if unsupported>"
}

**VERIFICATION RULES:**

1. **For numbers:**
   - 5% tolerance is ACCEPTABLE (accounting for currency/rounding).
   - Unit differences (k, M, B) are ACCEPTABLE.
   - "Maintainable", "Adjusted", "Recurring", "Pro-forma", "Normalized" are often synonyms.

2. **For arrays (e.g. EBITDA Adjustments, Competitors):**
   - **CRITICAL:** If you see a table or list in the text that resembles the extracted array, mark as SUPPORTED.
   - It does NOT need to be an exact item-for-item match.
   - If the *amounts* or *categories* match roughly, it is VALID.
   - Do NOT fail just because of slight naming differences (e.g. "Founder's Salary" vs "Owner Comp").

3. **For Summaries/Assessments:**
   - If the text supports the *sentiment* or *conclusion*, mark as SUPPORTED.

4. **Hallucinations:**
   - ONLY mark as unsupported if the data is *clearly* wrong or *completely* invented.
   - If the chunk text is sparse but mentions the concept, mark as SUPPORTED (Implicit) with low confidence.
   - Be biased towards SUPPORTED unless proven otherwise.

Return the verification:`;

// -----------------------------------------------------------------------------
// BATCH VERIFICATION PROMPT - Verify multiple fields at once (cost optimization)
// -----------------------------------------------------------------------------

export const BATCH_VERIFICATION_SYSTEM_PROMPT = `You are a verification analyst checking multiple extracted fields.

Your goal is to CONFIRM the extraction where possible.
Be LENIENT with terminology and rounding.
Be STRICT only about clear contradictions.

If a value is "close enough" or "likely derived from" the text, mark is_supported: true.`;

export const BATCH_VERIFICATION_USER_PROMPT = `Verify these extracted fields against the source chunks.

**FIELDS TO VERIFY:**
{{FIELDS_JSON}}

**SOURCE CHUNKS BY FIELD:**
{{CHUNKS_BY_FIELD}}

**OUTPUT FORMAT:** Return ONLY valid JSON - an array of verifications:

[
  {
    "field_path": "<field path>",
    "is_supported": <true|false>,
    "support_type": "<explicit|implicit|calculated|plausible|unsupported>",
    "confidence": <0.0-1.0>,
    "source_page": <page number or null>,
    "source_quote": "<supporting quote or null>",
    "notes": "<verification notes>"
  }
]

**RULES:**
- For numbers: 5% tolerance for rounding, account for currency/units.
- For arrays (e.g. adjustments): If *some* items are found, mark as 'implicit' or 'plausible' with moderate confidence (0.7+). Do NOT hard fail unless completely absent.
- For financial terms: 'Adjusted', 'Normalized', 'Recurring', 'Pro Forma' are often used interchangeably.
- If chunks describe the *components* of a sum (e.g. EBITDA + Adj 1 + Adj 2), consider the final sum 'calculated'.
- If no relevant chunks found for a field, mark as unsupported with confidence 0.

Return the verifications:`;

// -----------------------------------------------------------------------------
// OVERALL CONFIDENCE CALCULATION
// -----------------------------------------------------------------------------

export const CONFIDENCE_SUMMARY_SYSTEM_PROMPT = `You are summarizing verification results into an overall confidence assessment.`;

export const CONFIDENCE_SUMMARY_USER_PROMPT = `Calculate overall confidence for this extraction based on field verifications.

**DD TYPE:** {{DD_TYPE}}

**FIELD VERIFICATIONS:**
{{VERIFICATIONS_JSON}}

**OUTPUT FORMAT:** Return ONLY valid JSON:

{
  "overall_confidence": <0.0-1.0>,
  "confidence_breakdown": {
    "critical_fields_verified": <count>,
    "critical_fields_total": <count>,
    "high_fields_verified": <count>,
    "high_fields_total": <count>
  },
  "hallucination_flags": [
    "<field_path that is unsupported>"
  ],
  "completeness_score": <0-100>,
  "quality_grade": "<A|B|C|D|F>",
  "summary": "<2-3 sentence summary of verification results>",
  "recommendations": [
    "<action to take if issues found>"
  ]
}

**SCORING RULES:**

**Overall Confidence:**
- Start at 1.0
- Subtract 0.15 for each unsupported critical field
- Subtract 0.10 for each unsupported high field
- Subtract 0.05 for each unsupported medium field
- Minimum 0.0

**Completeness Score:**
- 100 = all critical + high fields verified
- 75 = all critical fields verified, some high missing
- 50 = most critical fields verified
- 25 = some critical fields missing
- 0 = most fields unsupported

**Quality Grade:**
- A: confidence >= 0.9, no critical hallucinations
- B: confidence >= 0.75, no critical hallucinations
- C: confidence >= 0.6, max 1 critical hallucination
- D: confidence >= 0.4
- F: confidence < 0.4 or multiple critical hallucinations

Return the summary:`;

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Get value from nested object by path
 */
export function getValueByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  
  return current;
}

/**
 * Extract fields to validate from an extraction object
 */
export function extractFieldsToValidate(
  extraction: Record<string, unknown>,
  ddType: string
): FieldToValidate[] {
  const criticalFields = CRITICAL_FIELDS[ddType] || [];
  
  return criticalFields.map(field => ({
    ...field,
    extracted_value: getValueByPath(extraction, field.field_path) as string | number | boolean | null,
  })).filter(f => f.extracted_value !== undefined && f.extracted_value !== null);
}

/**
 * Build verification prompt for a single field
 */
export function buildFieldVerificationPrompt(
  fieldPath: string,
  extractedValue: unknown,
  chunks: ChunkMatch[]
): { system: string; user: string } {
  const chunksText = chunks.map((c, i) => 
    `[Chunk ${i + 1}${c.page_number ? ` - Page ${c.page_number}` : ''} (similarity: ${c.similarity_score.toFixed(2)})]:\n${c.chunk_text}`
  ).join('\n\n');
  
  const valueStr = typeof extractedValue === 'object' 
    ? JSON.stringify(extractedValue, null, 2)
    : String(extractedValue);
  
  const prompt = FIELD_VERIFICATION_USER_PROMPT
    .replace('{{FIELD_PATH}}', fieldPath)
    .replace('{{EXTRACTED_VALUE}}', valueStr)
    .replace('{{CHUNKS}}', chunksText || 'No relevant chunks found');
  
  return {
    system: FIELD_VERIFICATION_SYSTEM_PROMPT,
    user: prompt,
  };
}

/**
 * Build batch verification prompt for multiple fields
 */
export function buildBatchVerificationPrompt(
  fields: { field_path: string; extracted_value: unknown; chunks: ChunkMatch[] }[]
): { system: string; user: string } {
  const fieldsJson = fields.map(f => ({
    field_path: f.field_path,
    extracted_value: f.extracted_value,
  }));
  
  const chunksByField = fields.map(f => ({
    field_path: f.field_path,
    chunks: f.chunks.map((c, i) => ({
      index: i + 1,
      page: c.page_number,
      similarity: c.similarity_score.toFixed(2),
      text: c.chunk_text.slice(0, 500), // Truncate for token efficiency
    })),
  }));
  
  const prompt = BATCH_VERIFICATION_USER_PROMPT
    .replace('{{FIELDS_JSON}}', JSON.stringify(fieldsJson, null, 2))
    .replace('{{CHUNKS_BY_FIELD}}', JSON.stringify(chunksByField, null, 2));
  
  return {
    system: BATCH_VERIFICATION_SYSTEM_PROMPT,
    user: prompt,
  };
}

/**
 * Build confidence summary prompt
 */
export function buildConfidenceSummaryPrompt(
  ddType: string,
  verifications: FieldVerification[]
): { system: string; user: string } {
  const prompt = CONFIDENCE_SUMMARY_USER_PROMPT
    .replace('{{DD_TYPE}}', ddType)
    .replace('{{VERIFICATIONS_JSON}}', JSON.stringify(verifications, null, 2));
  
  return {
    system: CONFIDENCE_SUMMARY_SYSTEM_PROMPT,
    user: prompt,
  };
}

// -----------------------------------------------------------------------------
// VALIDATION SERVICE INTERFACE
// -----------------------------------------------------------------------------

/**
 * Interface for the validation service - to be implemented with actual embedding search
 * 
 * Usage:
 * 
 * 1. Extract fields to validate:
 *    const fields = extractFieldsToValidate(extraction, 'financial');
 * 
 * 2. For each field, build search query and find chunks:
 *    const query = buildSearchQuery(field.field_path, field.extracted_value);
 *    const chunks = await vectorSearch(documentId, query, topK=3);
 * 
 * 3. Build verification prompt with chunks:
 *    const prompt = buildFieldVerificationPrompt(field.field_path, field.extracted_value, chunks);
 *    const result = await llm.complete(prompt);
 * 
 * 4. Aggregate results:
 *    const summary = buildConfidenceSummaryPrompt(ddType, verifications);
 */

export interface ValidationService {
  /**
   * Search for chunks relevant to a field
   */
  searchChunks(documentId: string, query: string, topK?: number): Promise<ChunkMatch[]>;
  
  /**
   * Verify a single field against its chunks
   */
  verifyField(fieldPath: string, value: unknown, chunks: ChunkMatch[]): Promise<FieldVerification>;
  
  /**
   * Verify multiple fields in batch (cost optimization)
   */
  verifyFieldsBatch(fields: { field_path: string; value: unknown; chunks: ChunkMatch[] }[]): Promise<FieldVerification[]>;
  
  /**
   * Full validation pipeline
   */
  validateExtraction(
    documentId: string,
    extraction: Record<string, unknown>,
    ddType: string
  ): Promise<ValidationResult>;
}

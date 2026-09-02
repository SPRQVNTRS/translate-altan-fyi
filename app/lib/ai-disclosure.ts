/**
 * The one disclosure label, for every surface that shows machine-written text.
 *
 * THIS IS A LEGAL REQUIREMENT, NOT A LABEL WE CHOSE. EU AI Act Article 50 puts
 * the disclosure duty on the deployer, and neither the enrichment notes nor a
 * server transcription is reviewed by a person before it reaches the reader. So
 * the reader has to be told, on the page, that a model produced the text and
 * which model that was.
 *
 * IT IS A CONSTANT BECAUSE THERE ARE NOW TWO SURFACES. The enrichment panel
 * renders it under study notes, and the voice fallback renders it under a
 * transcript. A duty discharged by two copied strings is a duty one of them
 * eventually drops, and a renamed catalogue key would fail silently on the
 * copy nobody opened.
 *
 * Client safe on purpose: the key travels from a server route to the browser
 * inside a JSON body, and the browser resolves it against `app/locales/`.
 * No English sentence is ever sent from the server for this.
 */

/** The i18next key of the disclosure sentence. It takes one `{{model}}` placeholder. */
export const GENERATED_BY_LABEL_KEY = 'enrichment.generatedBy';

/** What a machine-written answer carries so its surface can label it. */
export interface GeneratedByLabel {
  /** The model id exactly as it ran, which is what the sentence names. */
  model: string;
  /** The catalogue key the browser resolves. Never an English sentence. */
  labelKey: typeof GENERATED_BY_LABEL_KEY;
}

/**
 * The label for one model id.
 *
 * @param model the model id as the registry reported it after the call, never
 *   the one that was requested: a provider may serve a different revision, and
 *   the sentence must name what actually answered.
 */
export function generatedByLabel(model: string): GeneratedByLabel {
  return { model, labelKey: GENERATED_BY_LABEL_KEY };
}

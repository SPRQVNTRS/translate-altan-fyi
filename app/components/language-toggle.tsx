import { useTranslation } from 'react-i18next';
import { Label } from '#app/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#app/components/ui/select';
import {
  DEFAULT_LANGUAGE,
  isLanguageCode,
  LANGUAGE_LABELS,
  selectLanguage,
  SUPPORTED_LANGUAGES,
} from '#app/i18n/language-prefs';

/** The id the `Label` binds to, and the id Radix puts on the trigger button. */
const TRIGGER_ID = 'app-language';

/**
 * The app-language picker, rendered on the settings screen.
 *
 * The options are the NATIVE names (`English`, `Deutsch`), never translated. A
 * visitor who has landed in a language they cannot read has to be able to find
 * their own one in the list, and a translated list defeats exactly that.
 *
 * Choosing a language goes through `selectLanguage`, which writes the cookie
 * and the localStorage mirror and then reloads the document. The reload is the
 * point: the server re-renders from the new cookie, so the page is never half
 * translated and SSR and the client are never live in two different languages.
 *
 * Render-safe on the server: `selectLanguage` and the storage helpers all guard
 * `document` themselves, and nothing here touches the DOM at module scope.
 */
export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const active = i18n.resolvedLanguage ?? i18n.language;
  const value = isLanguageCode(active) ? active : DEFAULT_LANGUAGE;

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={TRIGGER_ID}>{t('settings.languageFieldLabel')}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          // Radix hands back a plain string. Narrow it rather than assert it:
          // an unsupported code must be ignored, never written to the cookie
          // the server renders from.
          if (isLanguageCode(next)) selectLanguage(next);
        }}
      >
        <SelectTrigger id={TRIGGER_ID} className="w-full sm:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SUPPORTED_LANGUAGES.map((code) => (
            <SelectItem key={code} value={code}>
              {LANGUAGE_LABELS[code]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

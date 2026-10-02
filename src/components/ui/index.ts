// The design-system form primitives (DS-10). Import from '@/components/ui'.
//
//   Field        label + one control + error + hint, wired by id
//   Input        text-like inputs, including the native date and time types
//   Select       the native select with the drawn chevron
//   Textarea     rows decide its height, never less than one control
//   SearchInput  type=search with the glyph inside
//   Checkbox     a native checkbox inside its own label
//   Switch       role=switch on a native checkbox; submits "on"
//   EmailPreview email HTML in a sandboxed iframe (client component)
//
// Bare <input>, <select> and <textarea> already look the same (base.css);
// the components add the wiring and survive legacy contexts.

export {
  Field,
  joinIds,
  type FieldControlProps,
  type FieldLayout,
  type FieldProps,
  type FieldWidth,
} from './Field';
export { Input, INPUT_TYPES, type ControlSize, type InputProps, type InputType } from './Input';
export { Select, type SelectProps } from './Select';
export { Textarea, type TextareaProps } from './Textarea';
export { SearchInput, type SearchInputProps } from './SearchInput';
export {
  Checkbox,
  Switch,
  type CheckboxProps,
  type ChoiceName,
  type SwitchProps,
} from './Checkbox';
export { EmailPreview, type EmailPreviewProps } from './EmailPreview';
export {
  EMAIL_PREVIEW_CSP,
  EMAIL_PREVIEW_SANDBOX,
  emailPreviewDocument,
} from './email-preview-document';

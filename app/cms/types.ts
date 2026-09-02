import type { z } from "zod";

export type CollectionType = "content" | "data";

export interface BaseConfig<TSchema extends z.ZodTypeAny> {
  name: string;
  dir: string; // relative to project root (e.g., content/collections/articles)
  schema: TSchema;
}

export interface ContentConfig<TSchema extends z.ZodTypeAny> extends BaseConfig<TSchema> {
  type: "content";
  slugFrom?: "filename" | "frontmatter";
  draftBehavior?: "hideInProd" | "alwaysInclude";
}

export interface DataConfig<TSchema extends z.ZodTypeAny> extends BaseConfig<TSchema> {
  type: "data";
}

export type AnyConfig<TSchema extends z.ZodTypeAny = z.ZodTypeAny> =
  | ContentConfig<TSchema>
  | DataConfig<TSchema>;

export type InferSchema<T extends z.ZodTypeAny> = z.infer<T>;

export interface ContentEntry<TFrontmatter> {
  slug: string;
  frontmatter: TFrontmatter;
  bodyHtml?: string;
  bodyRaw?: string;
  file: string; // absolute path
}

export interface DataItem<TData> {
  id: string; // filename without extension
  data: TData;
  file: string; // absolute path
}


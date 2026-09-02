import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import yaml from "yaml";
import { z } from "zod";

import { registry } from "#app/cms/registry";
import type { ContentEntry, DataItem, AnyConfig, ContentConfig, DataConfig } from "#app/cms/types";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/**
 * The fields the loader itself reads from every frontmatter, independent of the
 * collection's own schema. Parsed once, at the same boundary as the collection
 * schema, so the rest of the loader branches on a domain value.
 */
const loaderFieldsSchema = z
  .object({
    draft: z.boolean().optional(),
    slug: z.string().optional(),
    date: z.string().optional(),
  })
  .loose();

type LoaderFields = z.infer<typeof loaderFieldsSchema>;

interface ParsedContent<TFrontmatter> {
  frontmatter: TFrontmatter;
  loaderFields: LoaderFields;
  bodyRaw?: string;
  bodyHtml?: string;
}

/**
 * gray-matter decodes an unquoted YAML date into a `Date`; collection schemas
 * declare `date` as an ISO string. Normalize before validating either way.
 */
const yamlDateFrontmatterSchema = z
  .object({ date: z.date() })
  .loose()
  .transform(({ date, ...rest }) => ({ ...rest, date: date.toISOString().slice(0, 10) }));

function normalizeYamlDates<TFrontmatter>(data: TFrontmatter) {
  const normalized = yamlDateFrontmatterSchema.safeParse(data);
  return normalized.success ? normalized.data : data;
}

function absoluteDir(dir: string) {
  return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
}

async function listFiles(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(dir, e.name));
}

function baseId(filePath: string) {
  return path.basename(filePath).replace(/\.[^.]+$/, "");
}

async function readText(filePath: string) {
  return fs.readFile(filePath, "utf-8");
}

function parseContentFrontmatter<T extends z.ZodTypeAny>(
  schema: T,
  filePath: string,
  content: string,
): ParsedContent<z.infer<T>> {
  if (filePath.endsWith(".md") || filePath.endsWith(".markdown") || filePath.endsWith(".mdx")) {
    const { data, content: body } = matter(content);
    const normalized = normalizeYamlDates(data);
    const result = schema.safeParse(normalized);
    if (!result.success) {
      throw new Error(
        `Frontmatter validation failed for ${filePath}: ${result.error.message}`,
      );
    }
    const bodyHtml = body ? md.render(body) : undefined;
    return {
      frontmatter: result.data,
      loaderFields: loaderFieldsSchema.parse(normalized),
      bodyRaw: body,
      bodyHtml,
    };
  }
  if (filePath.endsWith(".yml") || filePath.endsWith(".yaml")) {
    const normalized = normalizeYamlDates(yaml.parse(content));
    const result = schema.safeParse(normalized);
    if (!result.success) {
      throw new Error(
        `Frontmatter validation failed for ${filePath}: ${result.error.message}`,
      );
    }
    return {
      frontmatter: result.data,
      loaderFields: loaderFieldsSchema.parse(normalized),
      bodyRaw: undefined,
      bodyHtml: undefined,
    };
  }
  throw new Error(`Unsupported content extension for ${filePath}`);
}

function parseData<T extends z.ZodTypeAny>(schema: T, filePath: string, content: string): z.infer<T> {
  let data;
  if (filePath.endsWith(".yml") || filePath.endsWith(".yaml")) {
    data = yaml.parse(content);
  } else if (filePath.endsWith(".json")) {
    data = JSON.parse(content);
  } else {
    throw new Error(`Unsupported data extension for ${filePath}`);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Data validation failed for ${filePath}: ${result.error.message}`);
  }
  return result.data;
}

function shouldExcludeDraft(
  fields: LoaderFields,
  behavior: ContentConfig<z.ZodTypeAny>["draftBehavior"],
) {
  if (behavior === "alwaysInclude") return false;
  const isProd = process.env.NODE_ENV === "production";
  return isProd && fields.draft === true;
}

function readSlugFrom(fields: LoaderFields): string | undefined {
  const slug = fields.slug?.trim();
  return slug && slug.length > 0 ? slug : undefined;
}

function isContentConfig<TSchema extends z.ZodTypeAny>(cfg: AnyConfig): cfg is ContentConfig<TSchema> {
  return cfg.type === "content";
}

function isDataConfig<TSchema extends z.ZodTypeAny>(cfg: AnyConfig): cfg is DataConfig<TSchema> {
  return cfg.type === "data";
}

export async function getCollection<TSchema extends z.ZodTypeAny>(
  name: keyof typeof registry,
  opts?: { filterDrafts?: boolean },
): Promise<ContentEntry<z.infer<TSchema>>[]> {
  const cfg: AnyConfig = registry[name];
  if (!cfg || !isContentConfig<TSchema>(cfg)) throw new Error(`Unknown content collection: ${String(name)}`);
  const abs = absoluteDir(cfg.dir);
  const files = await listFiles(abs);

  const allowed = [".md", ".markdown", ".mdx", ".yml", ".yaml"];
  const entries: ContentEntry<z.infer<TSchema>>[] = [];
  const dates = new Map<string, string | undefined>();
  const seenSlugs = new Set<string>();

  for (const f of files) {
    if (!allowed.some((ext) => f.endsWith(ext))) continue;
    const raw = await readText(f);
    const parsed = parseContentFrontmatter(cfg.schema, f, raw);

    const fmSlug = cfg.slugFrom === "frontmatter" ? readSlugFrom(parsed.loaderFields) : undefined;
    const slug = fmSlug ?? baseId(f);

    if (seenSlugs.has(slug)) {
      throw new Error(`Duplicate slug "${slug}" in ${cfg.name}`);
    }
    seenSlugs.add(slug);

    const excludeDraft = opts?.filterDrafts ?? cfg.draftBehavior === "hideInProd";
    if (excludeDraft && shouldExcludeDraft(parsed.loaderFields, cfg.draftBehavior)) {
      continue;
    }

    dates.set(slug, parsed.loaderFields.date);
    entries.push({
      slug,
      frontmatter: parsed.frontmatter,
      bodyHtml: parsed.bodyHtml,
      bodyRaw: parsed.bodyRaw,
      file: f,
    });
  }

  return entries.toSorted((a, b) => {
    // Default sort: date desc if present
    const ad = dates.get(a.slug);
    const bd = dates.get(b.slug);
    if (ad && bd) return bd.localeCompare(ad);
    return a.slug.localeCompare(b.slug);
  });
}

export async function getEntry<TSchema extends z.ZodTypeAny>(
  name: keyof typeof registry,
  slug: string,
): Promise<ContentEntry<z.infer<TSchema>> | null> {
  const entries = await getCollection<TSchema>(name);
  return entries.find((e) => e.slug === slug) ?? null;
}

export async function getDataset<TSchema extends z.ZodTypeAny>(
  name: keyof typeof registry,
): Promise<DataItem<z.infer<TSchema>>[]> {
  const cfg: AnyConfig = registry[name];
  if (!cfg || !isDataConfig<TSchema>(cfg)) throw new Error(`Unknown dataset: ${String(name)}`);
  const abs = absoluteDir(cfg.dir);
  const files = await listFiles(abs);
  const allowed = [".yml", ".yaml", ".json"];
  const items: DataItem<z.infer<TSchema>>[] = [];
  const seen = new Set<string>();

  for (const f of files) {
    if (!allowed.some((ext) => f.endsWith(ext))) continue;
    const raw = await readText(f);
    const id = baseId(f);
    if (seen.has(id)) throw new Error(`Duplicate id "${id}" in ${cfg.name}`);
    seen.add(id);
    const data = parseData(cfg.schema, f, raw);
    items.push({ id, data, file: f });
  }

  return items.toSorted((a, b) => a.id.localeCompare(b.id));
}

export async function getDatasetItem<TSchema extends z.ZodTypeAny>(
  name: keyof typeof registry,
  id: string,
): Promise<DataItem<z.infer<TSchema>> | null> {
  const items = await getDataset<TSchema>(name);
  return items.find((e) => e.id === id) ?? null;
}

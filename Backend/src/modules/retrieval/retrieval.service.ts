import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../../embedding/embedding-provider.interface';
import { RetrievalResult, RetrievedChunk } from './retrieved-chunk.interface';

export const DEFAULT_K = 5;

// Each search returns this many candidates before fusion, and only then is the list cut to k.
// If each side returned just k, fusion would have almost nothing to work with — the cases
// hybrid search exists for are chunks ranked ~8th semantically but 1st lexically, which a
// 5-row candidate list would have thrown away before fusion ever saw them.
const CANDIDATE_POOL = 20;

// The k in Reciprocal Rank Fusion's 1/(k + rank). 60 is the value from the original RRF paper
// and the default in Elasticsearch/OpenSearch. It damps the 1/rank curve: with k=60, ranks 1
// and 2 differ by only ~2%, so a chunk both searches rank moderately well beats one that wins
// a single list narrowly. A much smaller k would make first place dominate instead.
const RRF_K = 60;

@Injectable()
export class RetrievalService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  async retrieveRelevantChunks(
    workspaceId: number,
    query: string,
    k: number = DEFAULT_K,
  ): Promise<RetrievalResult> {
    const queryEmbedding = await this.embeddingProvider.embed(query);

    const embeddingLiteral = `[${queryEmbedding.join(',')}]`;

    // One statement, not two round trips: retrieval is synchronous (Phase 8) with a live
    // customer waiting, and ROW_NUMBER() produces exactly the ranks RRF needs without
    // shipping two candidate lists back to Node to be merged there.
    const rows = await this.dataSource.query(
      `
      WITH q AS (
        -- OR semantics, built from the question's own stemmed lexemes.
        --
        -- plainto_tsquery() would AND every term, which is wrong here and was proven wrong
        -- against real data: "How do I fix error E-4021 on my device?" becomes
        -- 'fix' & 'error' & 'e' & '-4021' & 'devic', and the very chunk containing E-4021
        -- fails to match purely because it lacks the word "fix". ORing means keyword search
        -- surfaces anything sharing a distinctive term and lets ts_rank plus RRF do the
        -- ordering, which is the job ranking is for.
        --
        -- A question made only of stop words produces an empty tsvector, so string_agg
        -- returns NULL, to_tsquery(NULL) is NULL, and "tsv @@ NULL" is never true — the
        -- keyword side simply contributes nothing and the query degrades to pure vector
        -- search rather than erroring.
        --
        -- Each lexeme is SINGLE-QUOTED, and that is not cosmetic. Lexemes can legitimately
        -- contain tsquery's own operator characters — a URL like https://example.com/a:b
        -- produces a lexeme ending in a colon-b, and unquoted, to_tsquery reads that as a
        -- WEIGHT FILTER (weight B). Nothing in this table has weight B, because plain
        -- to_tsvector assigns D to everything, so those terms would silently match nothing:
        -- not an error, just a quietly wrong result. Quoting makes each lexeme literal, and
        -- the doubled quote escapes any quote inside a lexeme.
        SELECT to_tsquery(
                 'english',
                 (
                   SELECT string_agg('''' || replace(lexeme, '''', '''''') || '''', ' | ')
                   FROM unnest(to_tsvector('english', $1))
                 )
               ) AS tsquery
      ),
      candidates AS (
        SELECT c.id, c.document_id, c.chunk_index, c.content, c.content_tsv, c.embedding
        FROM document_chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE d.workspace_id = $2
      ),
      vector_hits AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $3::vector) AS rank
        FROM candidates
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $3::vector
        LIMIT $4
      ),
      keyword_hits AS (
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank(c.content_tsv, q.tsquery) DESC, c.id) AS rank
        FROM candidates c, q
        WHERE q.tsquery IS NOT NULL AND c.content_tsv @@ q.tsquery
        ORDER BY ts_rank(c.content_tsv, q.tsquery) DESC, c.id
        LIMIT $4
      ),
      fused AS (
        -- FULL OUTER JOIN, because the whole point is that a chunk may appear in one list
        -- only. COALESCE on the score (not the rank) keeps a missing side contributing zero
        -- while leaving the rank itself NULL, which is real information worth returning.
        SELECT
          COALESCE(v.id, kw.id) AS id,
          v.rank AS vector_rank,
          kw.rank AS keyword_rank,
          COALESCE(1.0 / ($5 + v.rank), 0) + COALESCE(1.0 / ($5 + kw.rank), 0) AS rrf_score
        FROM vector_hits v
        FULL OUTER JOIN keyword_hits kw ON kw.id = v.id
      )
      SELECT
        c.id                       AS "chunkId",
        c.document_id              AS "documentId",
        d.original_filename        AS "originalFilename",
        c.chunk_index              AS "chunkIndex",
        c.content                  AS "content",
        f.vector_rank              AS "vectorRank",
        f.keyword_rank             AS "keywordRank",
        f.rrf_score                AS "rrfScore",
        -- Computed for every surviving row, including chunks only keyword search found, so
        -- the answer layer always has a real semantic distance to judge confidence on.
        c.embedding <=> $3::vector AS "distance"
      FROM fused f
      JOIN document_chunks c ON c.id = f.id
      JOIN documents d ON d.id = c.document_id
      ORDER BY f.rrf_score DESC, c.id
      LIMIT $6
      `,
      [query, workspaceId, embeddingLiteral, CANDIDATE_POOL, RRF_K, k],
    );

    return {
      chunks: rows.map((row: RetrievedChunk) => ({
        ...row,
        // Postgres returns double precision through the driver as a string often enough that
        // these conversions are load-bearing, not defensive padding.
        distance: row.distance === null ? Number.POSITIVE_INFINITY : Number(row.distance),
        vectorRank: row.vectorRank === null ? null : Number(row.vectorRank),
        keywordRank: row.keywordRank === null ? null : Number(row.keywordRank),
        rrfScore: Number(row.rrfScore),
      })),
      queryEmbedding,
    };
  }

  // How many chunks a question in this workspace is actually searched against. Counts only
  // embedded chunks, because a chunk with a NULL embedding is invisible to the vector side —
  // reporting the raw chunk count would overstate what retrieval can really see.
  async countSearchableChunks(workspaceId: number): Promise<number> {
    const rows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS count
       FROM document_chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.workspace_id = $1 AND c.embedding IS NOT NULL`,
      [workspaceId],
    );
    return rows[0]?.count ?? 0;
  }
}

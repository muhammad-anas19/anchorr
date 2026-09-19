import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../../embedding/embedding-provider.interface';
import { RetrievedChunk } from './retrieved-chunk.interface';

const DEFAULT_K = 5;

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
  ): Promise<RetrievedChunk[]> {
    const queryEmbedding = await this.embeddingProvider.embed(query);
    // pgvector expects its own literal text format ("[0.1,0.2,...]"), not a plain JS array —
    // TypeORM only performs that conversion automatically for entity columns going through
    // the repository API, not for a raw dataSource.query() parameter, so it's done by hand
    // here. The explicit ::vector cast tells Postgres how to interpret that string, since a
    // raw query parameter otherwise arrives untyped.
    const embeddingLiteral = `[${queryEmbedding.join(',')}]`;

    const rows = await this.dataSource.query(
      `SELECT c.id AS "chunkId",
              c.document_id AS "documentId",
              d.original_filename AS "originalFilename",
              c.chunk_index AS "chunkIndex",
              c.content AS "content",
              c.embedding <=> $1::vector AS "distance"
       FROM document_chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE d.workspace_id = $2
         AND c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $1::vector
       LIMIT $3`,
      [embeddingLiteral, workspaceId, k],
    );

    return rows.map((row: RetrievedChunk) => ({
      ...row,
      distance: Number(row.distance),
    }));
  }
}

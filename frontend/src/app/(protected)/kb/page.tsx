'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { useOrganization } from '@/contexts/OrganizationContext';
import api from '@/lib/api-client';
import { FeatureGate } from '@/components/FeatureGate';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  'http://127.0.0.1:8000'
).replace(/\/$/, '');
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  BookOpen,
  Upload,
  Search,
  FileText,
  Database,
  AlertCircle,
  CheckCircle,
  Loader2,
  X,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageShell } from '@/ui/motion/PageShell';
import { m } from 'framer-motion';
import { v } from '@/ui/motion/variants';

interface KBStats {
  documents: number;
  chunks: number;
}

interface SearchResult {
  faiss_id: number;
  score: number;
  document_id?: string;
  chunk_id?: string;
  text_preview?: string;
}

interface IngestResponse {
  document_id: string;
  chunks_ingested: number;
  vectors_added: number;
}

interface DocumentItem {
  id: string;
  title: string;
  source_type: string;
  chunk_count: number;
  created_at: string;
}

export default function KnowledgeBasePage() {
  const router = useRouter();
  const { currentOrganization, isReady } = useOrganization();
  const orgId = currentOrganization?.id;

  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<KBStats | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [rawText, setRawText] = useState('');
  const [filename, setFilename] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsFilter, setDocumentsFilter] = useState('');

  useEffect(() => {
    if (!isReady || !orgId) {
      setLoading(true);
      return;
    }

    const checkAuth = async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;
        if (!token) {
          router.push('/login');
          return;
        }
        const userInfo = await api.get('/api/me');
        if (userInfo.role === 'customer') {
          router.replace('/tickets');
          return;
        }
        setUser(userInfo);
        await loadStats();
      } catch {
        await supabase.auth.signOut();
        router.push('/login');
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, [router, isReady, orgId]);

  const loadStats = async () => {
    if (!orgId) return;
    try {
      const statsData = await api.get<KBStats>('/api/kb/stats', orgId);
      setStats(statsData);
    } catch {
      /* non-fatal */
    }
  };

  const loadDocuments = async () => {
    if (!orgId) return;
    setDocumentsLoading(true);
    try {
      const docs = await api.get<DocumentItem[]>('/api/kb/documents', orgId);
      setDocuments(docs);
    } catch {
      setDocuments([]);
    } finally {
      setDocumentsLoading(false);
    }
  };

  const deleteDocument = async (docId: string) => {
    if (!orgId) return;
    if (
      !window.confirm(
        'Delete this document and all its chunks? The AI will no longer use it to answer questions.'
      )
    ) {
      return;
    }
    try {
      await api.delete(`/api/kb/documents/${docId}`, orgId);
      toast.success('Document deleted');
      loadDocuments();
    } catch {
      toast.error('Failed to delete document');
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || !orgId) return;
    setSearchLoading(true);
    try {
      const results = await api.get<SearchResult[]>(
        `/api/kb/search?q=${encodeURIComponent(searchQuery)}&k=5`,
        orgId
      );
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) setSelectedFile(file);
  }, []);

  const handleFileUpload = async () => {
    if (!selectedFile && !rawText.trim()) {
      setUploadMessage({
        type: 'error',
        message: 'Please select a file or enter raw text',
      });
      return;
    }
    if (!orgId) {
      setUploadMessage({
        type: 'error',
        message: 'Organization context not loaded. Please refresh.',
      });
      return;
    }

    setUploadLoading(true);
    setUploadMessage(null);

    try {
      const formData = new FormData();
      if (selectedFile) formData.append('file', selectedFile);
      if (rawText.trim()) formData.append('raw_text', rawText);
      if (filename.trim()) formData.append('filename', filename);

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      const response = await fetch(`${API_BASE}/api/kb/ingest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Organization-ID': orgId,
        },
        body: formData,
      });

      if (!response.ok)
        throw new Error(`Upload failed: ${await response.text()}`);

      const result: IngestResponse = await response.json();
      setUploadMessage({
        type: 'success',
        message: `Ingested successfully — ${result.chunks_ingested} chunks, ${result.vectors_added} vectors added.`,
      });
      setSelectedFile(null);
      setRawText('');
      setFilename('');
      await loadStats();
    } catch (error) {
      setUploadMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Upload failed',
      });
    } finally {
      setUploadLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
          <p className="text-sm">Loading knowledge base…</p>
        </div>
      </div>
    );
  }

  const hasRepAccess = user?.role === 'rep' || user?.role === 'admin';

  return (
    <PageShell>
      <div className="max-w-5xl mx-auto space-y-6">
        {/* ── Header ── */}
        <m.div {...v.fadeUp} className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <BookOpen className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                Knowledge Base
              </h1>
              <p className="text-sm text-muted-foreground">
                AI-indexed documents your reps can search instantly
              </p>
            </div>
          </div>
          {stats && stats.documents > 0 && (
            <Badge variant="secondary" className="shrink-0 gap-1.5 py-1 px-2.5">
              <Sparkles className="w-3 h-3 text-primary" />
              Search ready
            </Badge>
          )}
        </m.div>

        {/* ── Stats row ── */}
        {stats && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              {
                label: 'Documents',
                value: stats.documents,
                icon: FileText,
                color: 'text-primary',
                bg: 'bg-primary/10',
                delay: 0,
              },
              {
                label: 'Knowledge Chunks',
                value: stats.chunks,
                icon: Database,
                color: 'text-violet-500',
                bg: 'bg-violet-500/10',
                delay: 0.05,
              },
              {
                label: 'Index Status',
                value: stats.documents > 0 ? 'Ready' : 'Empty',
                icon: stats.documents > 0 ? CheckCircle : X,
                color:
                  stats.documents > 0
                    ? 'text-success'
                    : 'text-muted-foreground',
                bg: stats.documents > 0 ? 'bg-success/10' : 'bg-muted/40',
                delay: 0.1,
              },
            ].map(s => (
              <m.div
                key={s.label}
                {...v.scaleIn}
                transition={{ delay: s.delay }}
              >
                <Card className="bg-surface border">
                  <CardContent className="p-4 flex items-center gap-3">
                    <div
                      className={`w-9 h-9 rounded-lg ${s.bg} flex items-center justify-center shrink-0`}
                    >
                      <s.icon className={`w-4.5 h-4.5 ${s.color}`} />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">{s.label}</p>
                      <p className={`text-xl font-bold ${s.color}`}>
                        {s.value}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </m.div>
            ))}
          </div>
        )}

        {/* ── Tabs ── */}
        <Tabs
          defaultValue="search"
          className="space-y-4"
          onValueChange={value => {
            if (value === 'manage' && hasRepAccess) loadDocuments();
          }}
        >
          <TabsList className="h-9">
            <TabsTrigger value="search" className="gap-1.5">
              <Search className="w-3.5 h-3.5" />
              Search
            </TabsTrigger>
            {hasRepAccess && (
              <TabsTrigger value="upload" className="gap-1.5">
                <Upload className="w-3.5 h-3.5" />
                Upload
              </TabsTrigger>
            )}
            {hasRepAccess && (
              <TabsTrigger value="manage" className="gap-1.5">
                <FileText className="w-3.5 h-3.5" />
                Manage
              </TabsTrigger>
            )}
          </TabsList>

          {/* ── Search tab ── */}
          <TabsContent value="search">
            <m.div {...v.scaleIn}>
              <Card className="bg-surface border">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Semantic Search</CardTitle>
                  <CardDescription>
                    Find relevant knowledge using natural language — not just
                    keywords.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g. How do I reset a customer password?"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleSearch()}
                      className="flex-1"
                    />
                    <Button
                      onClick={handleSearch}
                      disabled={searchLoading || !searchQuery.trim()}
                    >
                      {searchLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Search className="w-4 h-4" />
                      )}
                      <span className="ml-1.5 hidden sm:inline">Search</span>
                    </Button>
                  </div>

                  {searchResults.length > 0 && (
                    <div className="space-y-3">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {searchResults.length} result
                        {searchResults.length !== 1 ? 's' : ''}
                      </p>
                      {searchResults.map((result, i) => {
                        const pct = Math.round(result.score * 100);
                        return (
                          <m.div
                            key={result.faiss_id}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.04 }}
                          >
                            <Card className="border bg-card">
                              <CardContent className="p-4 space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="flex items-center gap-2 flex-1 min-w-0">
                                    <progress
                                      value={pct}
                                      max={100}
                                      aria-label={`${pct}% match`}
                                      className={`h-1.5 w-24 rounded-full [appearance:none] [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-border [&::-webkit-progress-value]:rounded-full [&::-moz-progress-bar]:rounded-full ${
                                        pct >= 80
                                          ? '[&::-webkit-progress-value]:bg-success [&::-moz-progress-bar]:bg-success'
                                          : pct >= 55
                                            ? '[&::-webkit-progress-value]:bg-warning [&::-moz-progress-bar]:bg-warning'
                                            : '[&::-webkit-progress-value]:bg-danger [&::-moz-progress-bar]:bg-danger'
                                      }`}
                                    />
                                    <span className="text-xs font-medium text-muted-foreground shrink-0">
                                      {pct}% match
                                    </span>
                                  </div>
                                  {result.document_id && (
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] shrink-0"
                                    >
                                      {result.document_id.slice(0, 8)}
                                    </Badge>
                                  )}
                                </div>
                                {result.text_preview && (
                                  <p className="text-sm text-foreground/80 leading-relaxed line-clamp-4">
                                    {result.text_preview}
                                  </p>
                                )}
                              </CardContent>
                            </Card>
                          </m.div>
                        );
                      })}
                    </div>
                  )}

                  {searchQuery &&
                    searchResults.length === 0 &&
                    !searchLoading && (
                      <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
                        <AlertCircle className="h-4 w-4 text-warning shrink-0" />
                        <p className="text-sm text-muted-foreground">
                          No results for &ldquo;{searchQuery}&rdquo;. Try
                          different phrasing or upload more documents.
                        </p>
                      </div>
                    )}

                  {!searchQuery && searchResults.length === 0 && (
                    <div className="flex flex-col items-center py-10 text-muted-foreground gap-2">
                      <Search className="w-10 h-10 opacity-20" />
                      <p className="text-sm">
                        Type a question to search your knowledge base
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </m.div>
          </TabsContent>

          {/* ── Upload tab ── */}
          {hasRepAccess && (
            <TabsContent value="upload">
              <FeatureGate feature="kb" description="Knowledge Base upload and AI indexing require Starter plan or above.">
              <m.div {...v.scaleIn}>
                <Card className="bg-surface border">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">
                      Upload Documents
                    </CardTitle>
                    <CardDescription>
                      Add files or paste text — they&apos;ll be chunked and
                      vector-indexed automatically.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {uploadMessage && (
                      <div
                        className={`flex items-start gap-2.5 rounded-lg border p-3 text-sm ${
                          uploadMessage.type === 'error'
                            ? 'border-danger/30 bg-danger/5 text-danger'
                            : 'border-success/30 bg-success/5 text-success'
                        }`}
                      >
                        {uploadMessage.type === 'error' ? (
                          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        ) : (
                          <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        )}
                        <p>{uploadMessage.message}</p>
                      </div>
                    )}

                    {/* Drag-and-drop zone */}
                    <div
                      onDragOver={e => {
                        e.preventDefault();
                        setDragOver(true);
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={handleDrop}
                      className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors cursor-pointer ${
                        dragOver
                          ? 'border-primary bg-primary/5'
                          : selectedFile
                            ? 'border-success/50 bg-success/5'
                            : 'border-border hover:border-primary/50 hover:bg-accent/40'
                      }`}
                      onClick={() =>
                        document.getElementById('kb-file-input')?.click()
                      }
                    >
                      <input
                        id="kb-file-input"
                        type="file"
                        accept=".txt,.pdf,.doc,.docx,.md"
                        aria-label="Upload knowledge base file"
                        className="sr-only"
                        onChange={e =>
                          setSelectedFile(e.target.files?.[0] || null)
                        }
                      />
                      <div
                        className={`w-11 h-11 rounded-xl flex items-center justify-center ${
                          selectedFile ? 'bg-success/10' : 'bg-primary/10'
                        }`}
                      >
                        {selectedFile ? (
                          <CheckCircle className="w-5 h-5 text-success" />
                        ) : (
                          <Upload className="w-5 h-5 text-primary" />
                        )}
                      </div>
                      {selectedFile ? (
                        <div>
                          <p className="text-sm font-medium text-foreground">
                            {selectedFile.name}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {(selectedFile.size / 1024).toFixed(1)} KB
                          </p>
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              setSelectedFile(null);
                            }}
                            className="mt-2 text-xs text-danger hover:underline"
                          >
                            Remove
                          </button>
                        </div>
                      ) : (
                        <div>
                          <p className="text-sm font-medium">
                            Drop a file here or click to browse
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            TXT, PDF, DOCX, MD supported
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <div className="flex-1 h-px bg-border" />
                      <span>or paste raw text</span>
                      <div className="flex-1 h-px bg-border" />
                    </div>

                    <div className="space-y-3">
                      <Textarea
                        placeholder="Paste your text content here…"
                        value={rawText}
                        onChange={e => setRawText(e.target.value)}
                        rows={5}
                      />
                      {rawText && (
                        <div>
                          <Label htmlFor="kb-filename" className="text-xs">
                            Filename for this text
                          </Label>
                          <Input
                            id="kb-filename"
                            placeholder="e.g. refund-policy.txt"
                            value={filename}
                            onChange={e => setFilename(e.target.value)}
                            className="mt-1"
                          />
                        </div>
                      )}
                    </div>

                    <Button
                      onClick={handleFileUpload}
                      disabled={
                        uploadLoading || (!selectedFile && !rawText.trim())
                      }
                      className="w-full"
                    >
                      {uploadLoading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin mr-2" />
                          Ingesting…
                        </>
                      ) : (
                        <>
                          <Upload className="w-4 h-4 mr-2" />
                          Ingest into Knowledge Base
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              </m.div>
              </FeatureGate>
            </TabsContent>
          )}

          {/* ── Manage tab ── */}
          {hasRepAccess && (
            <TabsContent value="manage">
              <FeatureGate feature="kb" description="Knowledge Base document management requires Starter plan or above.">
              <m.div {...v.scaleIn}>
                <Card className="bg-surface border">
                  <CardHeader className="pb-3 flex flex-row items-center justify-between">
                    <div>
                      <CardTitle className="text-base flex items-center gap-2">
                        <FileText className="h-4 w-4 text-primary" />
                        All Documents
                      </CardTitle>
                      <CardDescription>
                        {documents.length} document
                        {documents.length !== 1 ? 's' : ''} in your knowledge
                        base
                      </CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadDocuments}
                      disabled={documentsLoading}
                    >
                      {documentsLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      <span className="ml-1.5">Refresh</span>
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Input
                      placeholder="Filter by title…"
                      value={documentsFilter}
                      onChange={e => setDocumentsFilter(e.target.value)}
                    />

                    {documentsLoading ? (
                      <div className="flex justify-center py-10">
                        <Loader2 className="h-6 w-6 animate-spin text-primary" />
                      </div>
                    ) : documents.length === 0 ? (
                      <div className="flex flex-col items-center py-12 text-muted-foreground gap-2">
                        <FileText className="h-10 w-10 opacity-20" />
                        <p className="text-sm font-medium">No documents yet</p>
                        <p className="text-xs text-center max-w-xs">
                          Upload your first document in the Upload tab and it
                          will appear here.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-lg border overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-muted/40 border-b">
                              <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                                Title
                              </th>
                              <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden sm:table-cell">
                                Type
                              </th>
                              <th className="text-center px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                                Chunks
                              </th>
                              <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden md:table-cell">
                                Added
                              </th>
                              <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                                Actions
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {documents
                              .filter(
                                doc =>
                                  documentsFilter === '' ||
                                  doc.title
                                    .toLowerCase()
                                    .includes(documentsFilter.toLowerCase())
                              )
                              .map((doc, i) => (
                                <tr
                                  key={doc.id}
                                  className={`border-b last:border-0 hover:bg-accent/40 transition-colors ${
                                    i % 2 === 0 ? '' : 'bg-muted/20'
                                  }`}
                                >
                                  <td className="px-4 py-3">
                                    <div className="flex items-center gap-2">
                                      <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                                        <FileText className="w-3.5 h-3.5 text-primary" />
                                      </div>
                                      <div>
                                        <p className="font-medium truncate max-w-[180px]">
                                          {doc.title}
                                        </p>
                                        <p className="text-[10px] text-muted-foreground font-mono">
                                          {doc.id.slice(0, 8)}
                                        </p>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 hidden sm:table-cell">
                                    <Badge
                                      variant="outline"
                                      className="text-xs"
                                    >
                                      {doc.source_type}
                                    </Badge>
                                  </td>
                                  <td className="px-4 py-3 text-center">
                                    <span className="inline-flex items-center justify-center w-8 h-6 rounded-md bg-primary/10 text-primary text-xs font-semibold">
                                      {doc.chunk_count}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-xs text-muted-foreground hidden md:table-cell">
                                    {new Date(
                                      doc.created_at
                                    ).toLocaleDateString(undefined, {
                                      month: 'short',
                                      day: 'numeric',
                                      year: 'numeric',
                                    })}
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-destructive hover:text-destructive"
                                      onClick={() => deleteDocument(doc.id)}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </m.div>
              </FeatureGate>
            </TabsContent>
          )}
        </Tabs>
      </div>
    </PageShell>
  );
}

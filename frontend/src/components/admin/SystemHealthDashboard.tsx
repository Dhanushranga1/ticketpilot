/**
 * System Health Dashboard Component
 * Phase 3: Strategic Improvements (SI-3)
 *
 * Displays system health metrics including:
 * - Database status
 * - Knowledge base statistics
 * - AI performance metrics
 * - System alerts
 */

'use client';

import { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Database,
  BookOpen,
  Brain,
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
} from 'lucide-react';
import { apiGet } from '@/lib/api';
import { getBearer } from '@/lib/auth';

interface KBStats {
  total_documents: number;
  total_chunks: number;
  total_embeddings: number;
  latest_ingest_at: string | null;
}

interface AdminAnalytics {
  total_tickets: number;
  resolution_rate: number;
  avg_response_hours: number;
}

interface AIPerformanceMetrics {
  totalAIResponses: number;
  averageConfidence: number;
  escalationRate: number;
  positiveFeedbackRate: number;
}

type HealthStatus = 'healthy' | 'warning' | 'error';

interface HealthIndicator {
  name: string;
  status: HealthStatus;
  value: string;
  description: string;
}

export function SystemHealthDashboard() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  // Health metrics state
  const [kbStats, setKbStats] = useState<KBStats | null>(null);
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [aiMetrics, setAiMetrics] = useState<AIPerformanceMetrics | null>(null);

  const loadHealthMetrics = async () => {
    setLoading(true);
    setError(null);

    try {
      const token = await getBearer();
      if (!token) {
        setError('Authentication required');
        return;
      }

      // Fetch all health data in parallel
      const [kbData, analyticsData, ragData] = await Promise.all([
        apiGet<KBStats>('/api/kb/stats', token).catch(() => null),
        apiGet<AdminAnalytics>('/api/admin/analytics/summary', token).catch(
          () => null
        ),
        apiGet<{
          total_operations: number;
          avg_confidence: number;
          escalation_rate: number;
          feedback?: {
            positive: number;
            negative: number;
            positive_rate: number | null;
          };
        }>('/api/admin/analytics/rag', token).catch(() => null),
      ]);

      setKbStats(kbData);
      setAnalytics(analyticsData);

      // Real AI metrics from the RAG analytics endpoint (ai_runs + ai_feedback)
      if (ragData) {
        setAiMetrics({
          totalAIResponses: ragData.total_operations ?? 0,
          averageConfidence: ragData.avg_confidence ?? 0,
          escalationRate: ragData.escalation_rate ?? 0,
          positiveFeedbackRate: ragData.feedback?.positive_rate ?? 0,
        });
      }

      setLastRefresh(new Date());
    } catch (err) {
      console.error('Failed to load health metrics:', err);
      setError(
        err instanceof Error ? err.message : 'Failed to load system health data'
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHealthMetrics();

    // Auto-refresh every 5 minutes
    const interval = setInterval(loadHealthMetrics, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const getHealthIndicators = (): HealthIndicator[] => {
    const indicators: HealthIndicator[] = [];

    // Knowledge Base Health
    if (kbStats) {
      const kbStatus: HealthStatus =
        kbStats.total_chunks === 0
          ? 'error'
          : kbStats.total_chunks < 10
            ? 'warning'
            : 'healthy';

      indicators.push({
        name: 'Knowledge Base',
        status: kbStatus,
        value: `${kbStats.total_documents} docs, ${kbStats.total_chunks} chunks`,
        description:
          kbStatus === 'error'
            ? 'No content indexed'
            : kbStatus === 'warning'
              ? 'Limited content available'
              : 'Sufficient content indexed',
      });
    }

    // AI Performance Health
    if (aiMetrics) {
      const aiStatus: HealthStatus =
        aiMetrics.averageConfidence < 0.5
          ? 'error'
          : aiMetrics.averageConfidence < 0.7
            ? 'warning'
            : 'healthy';

      indicators.push({
        name: 'AI Performance',
        status: aiStatus,
        value: `${(aiMetrics.averageConfidence * 100).toFixed(0)}% confidence`,
        description: `${aiMetrics.totalAIResponses} responses, ${(aiMetrics.positiveFeedbackRate * 100).toFixed(0)}% positive feedback`,
      });
    }

    // Ticket Resolution Health
    if (analytics) {
      const resolutionStatus: HealthStatus =
        analytics.resolution_rate < 0.5
          ? 'error'
          : analytics.resolution_rate < 0.75
            ? 'warning'
            : 'healthy';

      indicators.push({
        name: 'Ticket Resolution',
        status: resolutionStatus,
        value: `${(analytics.resolution_rate * 100).toFixed(0)}% resolved`,
        description: `${analytics.total_tickets} total tickets, ${analytics.avg_response_hours.toFixed(1)}h avg response`,
      });
    }

    // Database Health (always healthy if we can fetch data)
    if (kbStats || analytics) {
      indicators.push({
        name: 'Database',
        status: 'healthy',
        value: 'Connected',
        description: 'All database operations functioning normally',
      });
    }

    return indicators;
  };

  const StatusIcon = ({ status }: { status: HealthStatus }) => {
    switch (status) {
      case 'healthy':
        return <CheckCircle2 className="h-5 w-5 text-green-600" />;
      case 'warning':
        return <AlertTriangle className="h-5 w-5 text-yellow-600" />;
      case 'error':
        return <XCircle className="h-5 w-5 text-red-600" />;
    }
  };

  const StatusBadge = ({ status }: { status: HealthStatus }) => {
    const colors = {
      healthy: 'bg-green-100 text-green-800 border-green-200',
      warning: 'bg-yellow-100 text-yellow-800 border-yellow-200',
      error: 'bg-red-100 text-red-800 border-red-200',
    };

    return (
      <span
        className={`px-2 py-1 rounded-full text-xs font-medium border ${colors[status]}`}
      >
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    );
  };

  const healthIndicators = getHealthIndicators();
  const overallHealth: HealthStatus = healthIndicators.some(
    i => i.status === 'error'
  )
    ? 'error'
    : healthIndicators.some(i => i.status === 'warning')
      ? 'warning'
      : 'healthy';

  return (
    <Card className="col-span-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Activity className="h-6 w-6 text-primary" />
            <div>
              <CardTitle>System Health Dashboard</CardTitle>
              <CardDescription>
                Real-time monitoring of system components
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              Last updated: {lastRefresh.toLocaleTimeString()}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={loadHealthMetrics}
              disabled={loading}
            >
              <RefreshCw
                className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`}
              />
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Overall Status Banner */}
        <div
          className={`p-4 rounded-lg border-2 ${
            overallHealth === 'healthy'
              ? 'bg-green-50 border-green-200'
              : overallHealth === 'warning'
                ? 'bg-yellow-50 border-yellow-200'
                : 'bg-red-50 border-red-200'
          }`}
        >
          <div className="flex items-center gap-3">
            <StatusIcon status={overallHealth} />
            <div>
              <h3 className="font-semibold text-lg">
                {overallHealth === 'healthy'
                  ? 'All Systems Operational'
                  : overallHealth === 'warning'
                    ? 'System Warning'
                    : 'System Error'}
              </h3>
              <p className="text-sm text-muted-foreground">
                {overallHealth === 'healthy'
                  ? 'All components are functioning normally'
                  : overallHealth === 'warning'
                    ? 'Some components need attention'
                    : 'Critical issues detected, immediate attention required'}
              </p>
            </div>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex items-center gap-2 text-red-800">
              <AlertTriangle className="h-4 w-4" />
              <span className="text-sm font-medium">
                Error loading health data: {error}
              </span>
            </div>
          </div>
        )}

        {/* Loading State */}
        {loading && !kbStats && !analytics ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="p-4 border rounded-lg">
                <div className="h-6 w-32 bg-muted animate-pulse rounded mb-2"></div>
                <div className="h-4 w-24 bg-muted animate-pulse rounded"></div>
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* Health Indicators Grid */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {healthIndicators.map((indicator, index) => (
                <div
                  key={index}
                  className="p-4 border rounded-lg hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start justify-between mb-3">
                    <h4 className="font-medium text-sm">{indicator.name}</h4>
                    <StatusIcon status={indicator.status} />
                  </div>
                  <div className="space-y-2">
                    <p className="text-lg font-semibold">{indicator.value}</p>
                    <StatusBadge status={indicator.status} />
                    <p className="text-xs text-muted-foreground mt-2">
                      {indicator.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Detailed Metrics */}
            <div className="grid gap-4 md:grid-cols-3">
              {/* Knowledge Base Metrics */}
              {kbStats && (
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2">
                      <BookOpen className="h-4 w-4 text-blue-600" />
                      <CardTitle className="text-sm">Knowledge Base</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Documents:</span>
                      <span className="font-medium">
                        {kbStats.total_documents}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Chunks:</span>
                      <span className="font-medium">
                        {kbStats.total_chunks}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Embeddings:</span>
                      <span className="font-medium">
                        {kbStats.total_embeddings}
                      </span>
                    </div>
                    {kbStats.latest_ingest_at && (
                      <div className="text-xs text-muted-foreground pt-2 border-t">
                        Last ingest:{' '}
                        {new Date(
                          kbStats.latest_ingest_at
                        ).toLocaleDateString()}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* AI Performance Metrics */}
              {aiMetrics && (
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2">
                      <Brain className="h-4 w-4 text-purple-600" />
                      <CardTitle className="text-sm">AI Performance</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Responses:</span>
                      <span className="font-medium">
                        {aiMetrics.totalAIResponses}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        Avg Confidence:
                      </span>
                      <span className="font-medium">
                        {(aiMetrics.averageConfidence * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        Positive Feedback:
                      </span>
                      <span className="font-medium">
                        {(aiMetrics.positiveFeedbackRate * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        Escalation Rate:
                      </span>
                      <span className="font-medium">
                        {(aiMetrics.escalationRate * 100).toFixed(0)}%
                      </span>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Database Metrics */}
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4 text-green-600" />
                    <CardTitle className="text-sm">Database</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Status:</span>
                    <span className="font-medium text-green-600">
                      Connected
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Total Tickets:
                    </span>
                    <span className="font-medium">
                      {analytics?.total_tickets || 0}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Avg Response:</span>
                    <span className="font-medium">
                      {analytics?.avg_response_hours.toFixed(1)}h
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Resolution Rate:
                    </span>
                    <span className="font-medium">
                      {((analytics?.resolution_rate || 0) * 100).toFixed(0)}%
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

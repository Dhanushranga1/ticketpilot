'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Bot,
  Copy,
  MessageSquare,
  ThumbsUp,
  ThumbsDown,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export interface AIResponse {
  content: string;
  confidence: number;
  model: string;
  suggest_escalation?: boolean;
  citations?: Array<{
    title: string;
    content: string;
    source?: string;
  }>;
  reasoning?: string;
}

interface AIResponseModalProps {
  open: boolean;
  onClose: () => void;
  response: AIResponse | null;
  ticketId: string;
  onInsert?: (content: string) => void;
  onEscalate?: () => void;
  onFeedback?: (positive: boolean) => void;
}

export function AIResponseModal({
  open,
  onClose,
  response,
  ticketId,
  onInsert,
  onEscalate,
  onFeedback,
}: AIResponseModalProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [feedbackGiven, setFeedbackGiven] = useState<boolean | null>(null);

  const handleCopy = async () => {
    if (!response?.content) return;

    try {
      await navigator.clipboard.writeText(response.content);
      toast.success('AI suggestion copied to clipboard');
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  const handleInsert = () => {
    if (!response?.content) return;
    onInsert?.(response.content);
    onClose();
  };

  const handleEscalate = () => {
    onEscalate?.();
    onClose();
  };

  const handleFeedback = (positive: boolean) => {
    setFeedbackGiven(positive);
    onFeedback?.(positive);
    toast.success(
      positive
        ? 'Thanks for the positive feedback!'
        : 'Thanks for the feedback!'
    );
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.8) return 'text-green-600 bg-green-50 border-green-200';
    if (confidence >= 0.6)
      return 'text-yellow-600 bg-yellow-50 border-yellow-200';
    return 'text-red-600 bg-red-50 border-red-200';
  };

  const getConfidenceLabel = (confidence: number) => {
    if (confidence >= 0.8) return 'High';
    if (confidence >= 0.6) return 'Medium';
    return 'Low';
  };

  if (!response) return null;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg font-semibold">
                AI-Generated Response Draft
              </DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                Review this AI-suggested response before sending to the
                customer. You can edit or use it as-is.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Confidence and Model Info */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge
            variant="outline"
            className={cn(
              'text-xs border font-medium',
              getConfidenceColor(response.confidence)
            )}
          >
            {Math.round(response.confidence * 100)}% Confidence •{' '}
            {getConfidenceLabel(response.confidence)}
          </Badge>

          {response.suggest_escalation && (
            <Badge variant="destructive" className="text-xs">
              <AlertTriangle className="h-3 w-3 mr-1" />
              Escalation Recommended
            </Badge>
          )}

          {response.citations && response.citations.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              <Bot className="h-3 w-3 mr-1" />
              {response.citations.length} sources
            </Badge>
          )}
        </div>

        {/* AI Response Content */}
        <div className="flex-1 overflow-auto space-y-4">
          <div className="bg-slate-50 dark:bg-slate-900 rounded-lg p-4 border">
            <div className="prose prose-sm max-w-none">
              <p className="text-base text-slate-800 dark:text-slate-200 leading-relaxed whitespace-pre-wrap m-0">
                {response.content}
              </p>
            </div>
          </div>

          {/* Escalation Warning */}
          {response.suggest_escalation && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <div className="flex items-center gap-2 text-red-800">
                <AlertTriangle className="h-4 w-4" />
                <span className="font-medium text-sm">
                  Escalation Recommended
                </span>
              </div>
              <p className="text-red-700 text-sm mt-1">
                The AI suggests this ticket should be escalated based on the
                complexity or urgency of the issue.
              </p>
            </div>
          )}

          {/* Knowledge Base Sources */}
          {response.citations && response.citations.length > 0 && (
            <div className="border rounded-lg">
              <Button
                variant="ghost"
                className="w-full justify-between p-3 h-auto"
                onClick={() => setSourcesOpen(!sourcesOpen)}
              >
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4" />
                  <span className="font-medium">
                    Knowledge Base Sources ({response.citations.length})
                  </span>
                </div>
                {sourcesOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </Button>
              {sourcesOpen && (
                <div className="p-3 pt-0 space-y-3">
                  {response.citations.map((citation, index) => (
                    <div
                      key={index}
                      className="bg-white border rounded-lg p-4 hover:bg-slate-50 transition-colors"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <ExternalLink className="h-4 w-4 text-slate-600 dark:text-slate-400" />
                        <span className="font-semibold text-base text-slate-900 dark:text-slate-100">
                          {citation.title}
                        </span>
                      </div>
                      {citation.content ? (
                        <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                          {citation.content}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">
                          Click source title to view full document
                        </p>
                      )}
                      {citation.source && (
                        <div className="mt-2 pt-2 border-t">
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            Source: {citation.source}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <Separator className="flex-shrink-0" />

        {/* Action Buttons */}
        <div className="flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            {/* Feedback Buttons */}
            <Button
              variant={feedbackGiven === true ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => handleFeedback(true)}
              disabled={feedbackGiven !== null}
            >
              <ThumbsUp className="h-4 w-4" />
            </Button>
            <Button
              variant={feedbackGiven === false ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => handleFeedback(false)}
              disabled={feedbackGiven !== null}
            >
              <ThumbsDown className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleCopy}>
              <Copy className="h-4 w-4 mr-2" />
              Copy
            </Button>

            {response.suggest_escalation && (
              <Button variant="destructive" onClick={handleEscalate}>
                <AlertTriangle className="h-4 w-4 mr-2" />
                Escalate Ticket
              </Button>
            )}

            <Button onClick={handleInsert}>
              <MessageSquare className="h-4 w-4 mr-2" />
              Send to Customer
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

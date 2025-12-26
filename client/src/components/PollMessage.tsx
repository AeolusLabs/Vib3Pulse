import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Check, ChartBar, Users, Lock, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import type { Poll, PollOption, PollVote, User } from "@shared/schema";

interface PollWithDetails extends Poll {
  options: Array<PollOption & { voteCount: number; voters: User[] }>;
  creator: User;
  userVotes?: PollVote[];
}

interface PollMessageProps {
  pollId: string;
  currentUserId: string;
  isOwnMessage?: boolean;
}

export default function PollMessage({ pollId, currentUserId, isOwnMessage }: PollMessageProps) {
  const { toast } = useToast();
  const [showVoters, setShowVoters] = useState<string | null>(null);

  const { data: poll, isLoading } = useQuery<PollWithDetails>({
    queryKey: ['/api/polls', pollId],
    enabled: !!pollId,
  });

  const voteMutation = useMutation({
    mutationFn: async (optionId: string) => {
      const response = await apiRequest("POST", `/api/polls/${pollId}/vote`, { optionId });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/polls', pollId] });
    },
    onError: (error: any) => {
      toast({ title: "Couldn't vote", description: error.message || "Try again", variant: "destructive" });
    },
  });

  const unvoteMutation = useMutation({
    mutationFn: async (optionId: string) => {
      await apiRequest("DELETE", `/api/polls/${pollId}/vote/${optionId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/polls', pollId] });
    },
  });

  const closePollMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/polls/${pollId}/close`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/polls', pollId] });
      toast({ title: "Poll closed" });
    },
  });

  if (isLoading || !poll) {
    return (
      <Card className="p-4 bg-muted/50">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm text-muted-foreground">Loading poll...</span>
        </div>
      </Card>
    );
  }

  const totalVotes = poll.options.reduce((sum, opt) => sum + opt.voteCount, 0);
  const userVotedOptionIds = new Set(poll.userVotes?.map(v => v.optionId) || []);
  const hasVoted = userVotedOptionIds.size > 0;
  const isClosed = poll.status === "closed";
  const isExpired = poll.expiresAt && new Date() > new Date(poll.expiresAt);
  const canVote = !isClosed && !isExpired;
  const isCreator = poll.creatorId === currentUserId;

  const handleVote = (optionId: string) => {
    if (!canVote) return;
    
    if (userVotedOptionIds.has(optionId)) {
      unvoteMutation.mutate(optionId);
    } else {
      voteMutation.mutate(optionId);
    }
  };

  return (
    <Card className={`p-4 max-w-sm ${isOwnMessage ? 'bg-primary/10' : 'bg-card'}`} data-testid={`poll-${pollId}`}>
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <ChartBar className="h-4 w-4 text-primary" />
              {isClosed && <Badge variant="secondary" className="text-xs"><Lock className="h-3 w-3 mr-1" />Closed</Badge>}
              {poll.allowMultiple && <Badge variant="outline" className="text-xs">Multiple</Badge>}
            </div>
            <h4 className="font-medium text-sm">{poll.question}</h4>
          </div>
        </div>

        <div className="space-y-2">
          {poll.options.map((option) => {
            const percentage = totalVotes > 0 ? Math.round((option.voteCount / totalVotes) * 100) : 0;
            const isVoted = userVotedOptionIds.has(option.id);
            const isPending = voteMutation.isPending || unvoteMutation.isPending;

            return (
              <div key={option.id} className="space-y-1">
                <button
                  onClick={() => handleVote(option.id)}
                  disabled={!canVote || isPending}
                  className={`w-full text-left p-2 rounded-lg border transition-colors ${
                    isVoted
                      ? 'border-primary bg-primary/10'
                      : canVote
                      ? 'border-border hover:border-primary/50 hover:bg-muted/50'
                      : 'border-border/50 opacity-70'
                  }`}
                  data-testid={`poll-option-${option.id}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm flex items-center gap-2">
                      {isVoted && <Check className="h-4 w-4 text-primary" />}
                      {option.text}
                    </span>
                    {(hasVoted || isClosed) && (
                      <span className="text-xs text-muted-foreground">{percentage}%</span>
                    )}
                  </div>
                  {(hasVoted || isClosed) && (
                    <Progress value={percentage} className="h-1.5" />
                  )}
                </button>

                {option.voteCount > 0 && (
                  <button
                    onClick={() => setShowVoters(showVoters === option.id ? null : option.id)}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                    data-testid={`show-voters-${option.id}`}
                  >
                    <Users className="h-3 w-3" />
                    {option.voteCount} vote{option.voteCount !== 1 ? 's' : ''}
                  </button>
                )}

                {showVoters === option.id && option.voters.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1 p-2 bg-muted/50 rounded">
                    {option.voters.slice(0, 10).map((voter) => (
                      <Avatar key={voter.id} className="h-6 w-6">
                        <AvatarImage src={voter.avatarUrl || ""} />
                        <AvatarFallback className="text-[10px]">
                          {voter.displayName?.[0] || voter.username[0]}
                        </AvatarFallback>
                      </Avatar>
                    ))}
                    {option.voters.length > 10 && (
                      <span className="text-xs text-muted-foreground self-center ml-1">
                        +{option.voters.length - 10} more
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2 border-t text-xs text-muted-foreground">
          <span>
            {totalVotes} vote{totalVotes !== 1 ? 's' : ''}
            {poll.expiresAt && !isClosed && (
              <> · Ends {formatDistanceToNow(new Date(poll.expiresAt), { addSuffix: true })}</>
            )}
          </span>
          {isCreator && canVote && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => closePollMutation.mutate()}
              disabled={closePollMutation.isPending}
              className="h-6 text-xs"
              data-testid="button-close-poll"
            >
              Close Poll
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

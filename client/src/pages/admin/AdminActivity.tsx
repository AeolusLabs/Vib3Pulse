import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { apiRequest } from "@/lib/queryClient";
import { exportToCsv } from "@/lib/exportToCsv";
import AdminLayout from "./AdminLayout";
import AdminPagination from "@/components/admin/AdminPagination";
import AdminDateRangePicker from "@/components/admin/AdminDateRangePicker";
import { format } from "date-fns";
import { ActivityIcon, LogInIcon, LogOutIcon, UserPlusIcon, BanIcon, FlagIcon, Trash2Icon, CheckIcon, XIcon, EditIcon, DownloadIcon } from "@/components/ui/icons";

const PAGE_SIZE = 50;

interface ActivityLog {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: string | null;
  ipAddress: string | null;
  createdAt: string;
  admin: {
    id: string;
    username: string;
    displayName: string;
    role: string;
  };
}

const actionIcons: Record<string, React.ReactNode> = {
  login: <LogInIcon className="w-4 h-4 text-green-400" />,
  logout: <LogOutIcon className="w-4 h-4 text-slate-400" />,
  create_admin: <UserPlusIcon className="w-4 h-4 text-purple-400" />,
  deactivate_admin: <BanIcon className="w-4 h-4 text-red-400" />,
  suspend_user: <BanIcon className="w-4 h-4 text-amber-400" />,
  lift_suspension: <CheckIcon className="w-4 h-4 text-green-400" />,
  delete_user: <Trash2Icon className="w-4 h-4 text-red-400" />,
  approve_event: <CheckIcon className="w-4 h-4 text-green-400" />,
  reject_event: <XIcon className="w-4 h-4 text-red-400" />,
  flag_event: <FlagIcon className="w-4 h-4 text-amber-400" />,
  delete_event: <Trash2Icon className="w-4 h-4 text-red-400" />,
  delete_story: <Trash2Icon className="w-4 h-4 text-red-400" />,
  review_report: <FlagIcon className="w-4 h-4 text-blue-400" />,
  update_admin: <EditIcon className="w-4 h-4 text-blue-400" />,
};

const actionLabels: Record<string, string> = {
  login: "Logged in",
  logout: "Logged out",
  create_admin: "Created admin user",
  deactivate_admin: "Deactivated admin",
  suspend_user: "Suspended user",
  lift_suspension: "Lifted suspension",
  delete_user: "Deleted user",
  approve_event: "Approved event",
  reject_event: "Rejected event",
  flag_event: "Flagged event",
  delete_event: "Deleted event",
  delete_story: "Deleted story",
  review_report: "Reviewed report",
  update_admin: "Updated admin",
};

export default function AdminActivity() {
  const [offset, setOffset] = useState(0);
  const [dateRange, setDateRange] = useState<{ from?: Date; to?: Date }>({});
  const [actionFilter, setActionFilter] = useState<string>("all");

  const actionTypes = Object.keys(actionLabels);

  const queryParams = new URLSearchParams();
  queryParams.set("limit", String(PAGE_SIZE));
  queryParams.set("offset", String(offset));
  if (dateRange.from) queryParams.set("from", dateRange.from.toISOString());
  if (dateRange.to) queryParams.set("to", dateRange.to.toISOString());
  if (actionFilter !== "all") queryParams.set("action", actionFilter);

  const { data, isLoading } = useQuery<{ logs: ActivityLog[]; total: number }>({
    queryKey: [
      "/api/admin/activity-logs",
      offset,
      dateRange.from?.toISOString(),
      dateRange.to?.toISOString(),
      actionFilter,
    ],
    queryFn: () =>
      apiRequest("GET", `/api/admin/activity-logs?${queryParams.toString()}`).then((r) =>
        r.json()
      ),
  });

  const logs = data?.logs || [];
  const total = data?.total || 0;

  const handleDateRangeChange = (range: { from?: Date; to?: Date }) => {
    setDateRange(range);
    setOffset(0);
  };

  const handleActionFilterChange = (value: string) => {
    setActionFilter(value);
    setOffset(0);
  };

  const handleExport = () => {
    exportToCsv(
      "activity-log",
      logs.map((log) => ({
        action: actionLabels[log.action] || log.action,
        admin: log.admin?.username ? `@${log.admin.username}` : "",
        targetType: log.targetType || "",
        targetId: log.targetId || "",
        details: log.details || "",
        ipAddress: log.ipAddress || "",
        createdAt: log.createdAt,
      }))
    );
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Activity Log</h1>
          <p className="text-slate-400 mt-1">
            Track all administrative actions on the platform
          </p>
        </div>

        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <CardTitle className="text-white flex items-center gap-2">
                <ActivityIcon className="w-5 h-5 text-purple-400" />
                Recent Activity
              </CardTitle>
              <div className="flex items-center gap-2 flex-wrap">
                <Select value={actionFilter} onValueChange={handleActionFilterChange}>
                  <SelectTrigger className="bg-slate-700/50 border-slate-600 text-white w-[180px]" data-testid="select-action-filter">
                    <SelectValue placeholder="All actions" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    <SelectItem value="all">All actions</SelectItem>
                    {actionTypes.map((action) => (
                      <SelectItem key={action} value={action}>
                        {actionLabels[action]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <AdminDateRangePicker
                  from={dateRange.from}
                  to={dateRange.to}
                  onChange={handleDateRangeChange}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExport}
                  disabled={logs.length === 0}
                  className="border-slate-600 text-slate-300"
                  data-testid="button-export-activity-csv"
                >
                  <DownloadIcon className="w-4 h-4 mr-1" /> Export CSV
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-slate-400">Loading activity...</div>
            ) : logs.length === 0 ? (
              <div className="text-center py-8 text-slate-400">No activity recorded yet</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700">
                    <TableHead className="text-slate-400">Action</TableHead>
                    <TableHead className="text-slate-400">Admin</TableHead>
                    <TableHead className="text-slate-400">Target</TableHead>
                    <TableHead className="text-slate-400">Details</TableHead>
                    <TableHead className="text-slate-400">IP Address</TableHead>
                    <TableHead className="text-slate-400">Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs?.map((log) => (
                    <TableRow key={log.id} className="border-slate-700">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {actionIcons[log.action] || <ActivityIcon className="w-4 h-4 text-slate-400" />}
                          <span className="text-white">
                            {actionLabels[log.action] || log.action}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="text-white">{log.admin.displayName}</p>
                          <p className="text-sm text-slate-400">@{log.admin.username}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        {log.targetType && log.targetId ? (
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="border-slate-500 text-slate-400">
                              {log.targetType}
                            </Badge>
                            <span className="text-slate-400 text-sm truncate max-w-[80px]">
                              {log.targetId}
                            </span>
                          </div>
                        ) : (
                          <span className="text-slate-500">-</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        {log.details ? (
                          <p className="text-slate-400 text-sm truncate" title={log.details}>
                            {log.details}
                          </p>
                        ) : (
                          <span className="text-slate-500">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-slate-400 text-sm">
                        {log.ipAddress || "-"}
                      </TableCell>
                      <TableCell className="text-slate-400">
                        <div>
                          <p>{format(new Date(log.createdAt), 'MMM d, yyyy')}</p>
                          <p className="text-sm">{format(new Date(log.createdAt), 'h:mm:ss a')}</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <AdminPagination
              offset={offset}
              limit={PAGE_SIZE}
              total={total}
              onOffsetChange={setOffset}
            />
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}

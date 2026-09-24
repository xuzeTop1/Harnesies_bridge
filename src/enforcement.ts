/**
 * 审批档位的"拦不拦得住"语义。
 *
 * 存在的理由:`supportedApprovals` 回答的是"桥肯不该给这个档",不是"对方的进程会不会真的收手"。
 * 两者不是一回事,而把它们混为一谈是本项目的风险面:调用方(另一个 harness)看到
 * `opencode: ['read-only']` 就会以为"只读档不会改我的盘",而实测它照样写文件、照样执行命令
 * (见 R7 那次 probe_write.txt 落到主仓库)。
 *
 * 所以档位要分三种说法,而且**默认必须是 unknown**:
 * 把没实测过的档位当成 enforced,就是拿"我不知道"当"安全"——同 AGENTS.md 证据纪律,
 * 也同云策略里"端点未知一律按不可信处理"那条的判据方向。
 */
import type { Adapter, ApprovalEnforcement, ApprovalLevel } from './types.ts';

export type { ApprovalEnforcement };

export function enforcementOf(adapter: Adapter, level: ApprovalLevel): ApprovalEnforcement {
  return adapter.approvalEnforcement?.[level] ?? 'unknown';
}

/**
 * 给调用方看的一句话。措辞要能阻止误用,所以 enforced 之外都必须自带"那什么才是约束"。
 */
export function enforcementNote(level: ApprovalLevel, e: ApprovalEnforcement): string {
  // 'full' 单独说:它的语义就是"不给约束",问它"拦不拦得住"是范畴错误。
  // 照抄下面三种措辞会产出一句看似谨慎、实则无意义的话("没实测过它会不会收手"——它本来就该不收手)。
  if (level === 'full') {
    return (
      `approval='full' 的含义就是**不加约束**:该模型会在无人确认下改动磁盘` +
      `(桥只在调用方显式给 allow_full=true 时放行)。别指望这一档拦住任何东西。`
    );
  }
  switch (e) {
    case 'enforced':
      return `approval='${level}' 由该 harness 自己的沙箱拦住(桥实测过)。`;
    case 'advisory':
      return (
        `approval='${level}' 在这家只是标签,**不会**因此停止写盘或执行命令(桥实测过)。` +
        `唯一的约束是提示词与结果里的 diskAudit —— 别把它当沙箱用。`
      );
    case 'unknown':
      return (
        `桥没有实测过这家在 approval='${level}' 下会不会真的收手,按"不确定"对待。` +
        `要确定性就靠提示词与结果里的 diskAudit,不要靠这个档位。`
      );
  }
}

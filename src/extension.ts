import * as vscode from 'vscode';
import { SourceInsightController } from './controller';

const VIEW_ID = 'sourceInsight.contextRelation';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new SourceInsightController(context);

  const register = (command: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, handler),
    );
  };

  context.subscriptions.push(
    controller,
    vscode.window.registerWebviewViewProvider(VIEW_ID, controller, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  register('sourceInsight.open', async () => {
    await controller.openPanel(undefined, true);
  });
  register('sourceInsight.refresh', async () => {
    await controller.refresh(true);
  });
  register('sourceInsight.toggleFollow', async () => {
    await controller.toggleFollow();
  });
  register('sourceInsight.goToDefinition', async () => {
    await controller.goToDefinition();
  });
  register('sourceInsight.clear', async () => {
    await controller.clear();
  });
  register('sourceInsight.focusContext', async () => {
    await controller.focusPane('context');
  });
  register('sourceInsight.focusRelation', async () => {
    await controller.focusPane('relation');
  });
  register('sourceInsight.openSettings', async () => {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      '@ext:onepiece-tools.source-insight-context-relation',
    );
  });
  register('sourceInsight.toggleContextLock', async () => {
    await controller.toggleLock('context');
  });
  register('sourceInsight.toggleRelationLock', async () => {
    await controller.toggleLock('relation');
  });
  register('sourceInsight.relationCallers', async () => {
    await controller.setRelationMode('callers');
  });
  register('sourceInsight.relationCallees', async () => {
    await controller.setRelationMode('callees');
  });
  register('sourceInsight.relationReferences', async () => {
    await controller.setRelationMode('references');
  });
  register('sourceInsight.relationBoth', async () => {
    await controller.setRelationMode('both');
  });
  register('sourceInsight.relationContains', async () => {
    await controller.setRelationMode('contains');
  });
  register('sourceInsight.relationType', async () => {
    await controller.setRelationMode('type');
  });
  register('sourceInsight.increaseDepth', async () => {
    await controller.adjustDepth(1);
  });
  register('sourceInsight.decreaseDepth', async () => {
    await controller.adjustDepth(-1);
  });
  register('sourceInsight.newRelationWindow', async () => {
    await controller.newRelationTab();
  });
  register('sourceInsight.closeRelationWindow', async () => {
    await controller.closeActiveRelationTab();
  });
  register('sourceInsight.nextRelationView', async () => {
    await controller.cycleLayout();
  });
  register('sourceInsight.copyRelationTree', async () => {
    await controller.copyRelationTree();
  });
  register('sourceInsight.openUserGuide', async () => {
    const guide = vscode.Uri.joinPath(context.extensionUri, 'docs', 'USER_GUIDE.md');
    try {
      await vscode.commands.executeCommand('markdown.showPreview', guide);
    } catch {
      await vscode.commands.executeCommand('vscode.open', guide);
    }
  });

  if (process.env.SOURCE_INSIGHT_TEST === '1') {
    register('sourceInsight.__getState', () => controller.getStateForTests());
  }
}

export function deactivate(): void {
  // All resources are disposed through the extension context subscriptions.
}

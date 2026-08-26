#import <UIKit/UIKit.h>

@interface ProbeAppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation ProbeAppDelegate
- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  (void)application;
  (void)launchOptions;
  UIViewController *controller = [[UIViewController alloc] init];
  controller.view.backgroundColor = UIColor.systemBackgroundColor;
  UILabel *label = [[UILabel alloc] init];
  label.text = @"orchestra-sim-probe";
  label.accessibilityIdentifier = @"orchestra-sim-probe-label";
  label.accessibilityTraits = UIAccessibilityTraitButton;
  label.translatesAutoresizingMaskIntoConstraints = NO;
  [controller.view addSubview:label];
  [NSLayoutConstraint activateConstraints:@[
    [label.centerXAnchor constraintEqualToAnchor:controller.view.centerXAnchor],
    [label.centerYAnchor constraintEqualToAnchor:controller.view.centerYAnchor]
  ]];
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController = controller;
  [self.window makeKeyAndVisible];
  return YES;
}
@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(ProbeAppDelegate.class));
  }
}

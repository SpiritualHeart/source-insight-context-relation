#include "APP_Model.h"

void APP_Model_Task10ms(void)
{
    g_app_model.state = g_app_model_state;
    g_app_model.enabled = (g_app_model.state != 0u);

    if (g_app_model_state != 0u)
    {
        APP_Model_Set29COutputs();
    }
}
